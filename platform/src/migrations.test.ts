import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool } from "./db.js";
import { listMigrationFiles, MigrationFailure, migrate, migrationStatus, stripTransaction } from "./migrations.js";

/**
 * A Postgres server for the tests that apply migrations, as a URL whose user
 * may create databases. CI sets it; without it those tests are skipped.
 */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"]?.trim() || undefined;
if (TEST_DATABASE_URL === undefined) console.warn("TEST_DATABASE_URL is not set: the Postgres tests in migrations.test.ts are skipped");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ogmcp-migrations-"));
}

describe("listMigrationFiles", () => {
  it("lists the files in numeric order and refuses a bad name or a number used twice", async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, "0002_second.sql"), "select 1;");
      writeFileSync(join(dir, "0001_first.sql"), "select 1;");
      writeFileSync(join(dir, "notes.md"), "not a migration");
      expect((await listMigrationFiles(dir)).map((file) => file.name)).toEqual(["0001_first.sql", "0002_second.sql"]);

      writeFileSync(join(dir, "0001_again.sql"), "select 1;");
      await expect(listMigrationFiles(dir)).rejects.toThrow(/same number/);
      rmSync(join(dir, "0001_again.sql"));

      writeFileSync(join(dir, "3_short.sql"), "select 1;");
      await expect(listMigrationFiles(dir)).rejects.toThrow(/3_short\.sql is not named NNNN_short_description\.sql/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("stripTransaction", () => {
  it("takes out a begin and commit pair, and refuses one without the other", () => {
    const sql = "-- 0002: tables.\n\nbegin;\n\ncreate table t (id int);\n\ncommit;\n";
    expect(stripTransaction("0002_x.sql", sql)).toBe("-- 0002: tables.\n\n\n\ncreate table t (id int);\n\n\n");
    expect(stripTransaction("0001_x.sql", "create table t (id int);\n")).toBe("create table t (id int);\n");
    expect(() => stripTransaction("0001_x.sql", "begin;\ncreate table t (id int);\n")).toThrow(/0001_x\.sql has a begin without a commit/);
    expect(() => stripTransaction("0001_x.sql", "create table t (id int);\ncommit;\n")).toThrow(/0001_x\.sql/);
  });
});

describe.skipIf(TEST_DATABASE_URL === undefined)("migrate against Postgres", () => {
  // Each run gets a database of its own on that server, and drops it.
  const name = `ogmcp_test_${randomBytes(6).toString("hex")}`;
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool({ url: TEST_DATABASE_URL ?? "", queryTimeoutMs: 10_000, max: 1 });
    await admin.query(`create database "${name}"`);
    const url = new URL(TEST_DATABASE_URL ?? "");
    url.pathname = `/${name}`;
    pool = createPool({ url: url.toString(), queryTimeoutMs: 10_000, max: 2 });
  });

  afterAll(async () => {
    await pool?.end();
    try {
      // force: a connection a failed test left open must not keep the database.
      await admin.query(`drop database if exists "${name}" with (force)`);
    } finally {
      await admin.end();
    }
  });

  it("applies the repo's files to an empty database, then applies nothing the second time", async () => {
    const files = await listMigrationFiles();
    expect(await migrationStatus(pool)).toEqual({ tracked: false, pending: files });

    const lines: string[] = [];
    expect(await migrate(pool, { log: (line) => lines.push(line) })).toEqual(files);
    expect(lines).toEqual(files.map((file) => `applied ${file.name}`));
    const tables = ["users", "oauth_identities", "web_sessions", "devices", "user_games", "uploads", "snapshots"];
    for (const table of tables) {
      expect((await pool.query("select to_regclass($1) as t", [table])).rows[0]).toEqual({ t: table });
    }

    expect(await migrationStatus(pool)).toEqual({ tracked: true, pending: [] });
    expect(await migrate(pool)).toEqual([]);
    const { rows } = await pool.query<{ version: number; name: string }>("select version, name from schema_migrations order by version");
    expect(rows).toEqual(files.map(({ version, name }) => ({ version, name })));
  });

  it("applies pending files in numeric order, and rolls a failed file back whole", async () => {
    // Runs after the test above, on a database where schema_migrations exists.
    const dir = tempDir();
    try {
      // 0101 needs the table of 0100: out of order, it would fail.
      writeFileSync(join(dir, "0101_fill.sql"), "insert into later (n) values (1);");
      writeFileSync(join(dir, "0100_later.sql"), "create table later (n int);");
      expect((await migrate(pool, { dir })).map((file) => file.name)).toEqual(["0100_later.sql", "0101_fill.sql"]);

      // Added after 0100 was applied, as a branch merged later would be.
      writeFileSync(join(dir, "0050_earlier.sql"), "begin;\ncreate table earlier (n int);\ncommit;\n");
      expect((await migrate(pool, { dir })).map((file) => file.name)).toEqual(["0050_earlier.sql"]);

      // The second statement fails: the first is rolled back, and the file and
      // the one after it stay pending.
      writeFileSync(join(dir, "0102_broken.sql"), "create table half (n int);\ncreate table half (n int);");
      writeFileSync(join(dir, "0103_after.sql"), "create table after_broken (n int);");
      const failure = await migrate(pool, { dir }).catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(MigrationFailure);
      expect((failure as MigrationFailure).file.name).toBe("0102_broken.sql");
      expect((failure as MigrationFailure).code).toBe("42P07");
      expect((failure as MigrationFailure).message).not.toContain("already exists");
      expect((await pool.query("select to_regclass('half') as t")).rows[0]).toEqual({ t: null });
      expect((await migrationStatus(pool, dir)).pending.map((file) => file.name)).toEqual(["0102_broken.sql", "0103_after.sql"]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
