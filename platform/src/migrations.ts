import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool, PoolClient } from "pg";

import { failureCode } from "./db.js";

/**
 * The migration runner (D1, §13.1). It applies the numbered SQL files of
 * `platform/migrations/` and records each one in `schema_migrations`.
 * `migrate.ts` is the command.
 *
 * Files are named `NNNN_short_description.sql`. A file is never edited once
 * it has been applied anywhere: a change is a new file with the next number.
 * There are no down-migrations. A file holds plain SQL, with no psql
 * meta-commands.
 *
 * A file is pending when `schema_migrations` has no row with its number.
 * Pending files run in numeric order, each in its own transaction together
 * with the insert of its row. A file that fails is rolled back whole and stays
 * pending; the files before it stay applied. A file added with a lower number
 * than one already applied is still pending and runs on the next migrate, so
 * two branches can each add a file and merge in either order.
 *
 * `0001` creates `schema_migrations`, so on an empty database it runs first
 * and records itself.
 *
 * One migrate runs at a time. A run holds a Postgres advisory lock from the
 * moment it reads what is applied until its last file commits, so two deploys,
 * or two self-host containers that start together (§13.3), never apply a file
 * twice.
 */

/** `platform/migrations`, one level up from this file under `src/` and under `dist/` alike. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

const FILE_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** The advisory lock key a migrate holds. Nothing else takes this lock. */
const MIGRATE_LOCK = 1_300_286;

export interface MigrationFile {
  /** The `NNNN` of the name, as a number. */
  version: number;
  name: string;
  path: string;
}

/** A failure of the database or of the connection to it. The message holds a code only (`failureCode`). */
export class DatabaseFailure extends Error {
  constructor(readonly code: string) {
    super(`database failure code=${code}`);
    this.name = "DatabaseFailure";
  }
}

/** A migration file that failed and was rolled back. The message names the file and the SQLSTATE, never the Postgres message. */
export class MigrationFailure extends Error {
  constructor(
    readonly file: MigrationFile,
    readonly code: string,
  ) {
    super(`${file.name} failed and was rolled back: code=${code}`);
    this.name = "MigrationFailure";
  }
}

/** The files of `dir` in numeric order. Throws on a `.sql` name outside `NNNN_name.sql` and on a number used twice. */
export async function listMigrationFiles(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const files: MigrationFile[] = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".sql")) continue;
    const match = FILE_NAME.exec(name);
    if (match === null) throw new Error(`migration file ${name} is not named NNNN_short_description.sql`);
    files.push({ version: Number(match[1]), name, path: join(dir, name) });
  }
  files.sort((a, b) => a.version - b.version);
  for (const [i, file] of files.entries()) {
    const previous = files[i - 1];
    if (previous !== undefined && previous.version === file.version) {
      throw new Error(`migration files ${previous.name} and ${file.name} have the same number`);
    }
  }
  return files;
}

/** The recorded versions, or null when `schema_migrations` does not exist yet. */
async function appliedVersions(client: Pool | PoolClient): Promise<Set<number> | null> {
  const { rows } = await client.query<{ table: string | null }>("select to_regclass('schema_migrations') as table");
  if (rows[0]?.table == null) return null;
  const applied = await client.query<{ version: number }>("select version from schema_migrations");
  return new Set(applied.rows.map((row) => row.version));
}

export interface MigrationStatus {
  /** False on a database where `0001` has not run. */
  tracked: boolean;
  pending: MigrationFile[];
}

/** What a migrate would apply, without applying it or taking the lock. */
export async function migrationStatus(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<MigrationStatus> {
  const files = await listMigrationFiles(dir);
  let applied: Set<number> | null;
  try {
    applied = await appliedVersions(pool);
  } catch (err) {
    throw new DatabaseFailure(failureCode(err));
  }
  return { tracked: applied !== null, pending: files.filter((file) => !applied?.has(file.version)) };
}

/**
 * A file may open with `begin;` and close with `commit;`, the form that runs
 * as-is under psql. The runner supplies the transaction itself, so both are
 * taken out; one without the other is refused. Comments before the first and
 * after the last statement stay.
 */
export function stripTransaction(name: string, sql: string): string {
  const opening = /^((?:\s*--[^\n]*\n|\s+)*)begin\s*;/i;
  const closing = /commit\s*;((?:\s*--[^\n]*)*\s*)$/i;
  const opens = opening.test(sql);
  const closes = closing.test(sql);
  if (opens !== closes) throw new Error(`migration file ${name} has a begin without a commit, or the other way round`);
  if (!opens) return sql;
  return sql.replace(opening, "$1").replace(closing, "$1");
}

export interface MigrateOptions {
  dir?: string;
  /** Receives one line per file applied. */
  log?: (line: string) => void;
}

/**
 * Applies every pending file, in numeric order, and returns them. Throws a
 * `MigrationFailure` naming the file that failed: the files before it stay
 * applied and recorded, and the failed one is rolled back. Throws a
 * `DatabaseFailure` when the database cannot be reached or asked.
 */
export async function migrate(pool: Pool, options: MigrateOptions = {}): Promise<MigrationFile[]> {
  const log = options.log ?? (() => {});
  const files = await listMigrationFiles(options.dir);

  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    throw new DatabaseFailure(failureCode(err));
  }
  let locked = false;
  try {
    let applied: Set<number> | null;
    try {
      await client.query("select pg_advisory_lock($1)", [MIGRATE_LOCK]);
      locked = true;
      applied = await appliedVersions(client);
    } catch (err) {
      throw new DatabaseFailure(failureCode(err));
    }
    const pending = files.filter((file) => !applied?.has(file.version));

    // Every pending file is read before the first one runs, so a bad file
    // stops the run before the database changes.
    const contents = new Map<MigrationFile, string>();
    for (const file of pending) contents.set(file, stripTransaction(file.name, await readFile(file.path, "utf8")));

    const done: MigrationFile[] = [];
    for (const file of pending) {
      try {
        await client.query("begin");
        // No parameters, so pg sends the text as one simple query and the
        // file may hold any number of statements.
        await client.query(contents.get(file) ?? "");
        await client.query("insert into schema_migrations (version, name) values ($1, $2)", [file.version, file.name]);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback").catch(() => {});
        throw new MigrationFailure(file, failureCode(err));
      }
      done.push(file);
      log(`applied ${file.name}`);
    }
    return done;
  } finally {
    // The lock belongs to the connection, and the connection goes back to the
    // pool. Unlock it, or drop the connection when the unlock fails.
    let reusable = true;
    if (locked) {
      await client.query("select pg_advisory_unlock($1)", [MIGRATE_LOCK]).catch(() => {
        reusable = false;
      });
    }
    client.release(!reusable);
  }
}
