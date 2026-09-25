import { randomBytes } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPool } from "./db.js";
import { configureLogger } from "./log.js";
import { migrate } from "./migrations.js";
import { deleteExpiredHistory } from "./retention.js";

/** As in migrations.test.ts: a Postgres server whose user may create databases. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"]?.trim() || undefined;
if (TEST_DATABASE_URL === undefined) console.warn("TEST_DATABASE_URL is not set: the Postgres tests in retention.test.ts are skipped");

const HEX64 = "a".repeat(64);

describe.skipIf(TEST_DATABASE_URL === undefined)("history retention against Postgres (§11, §14)", () => {
  const name = `ogmcp_test_${randomBytes(6).toString("hex")}`;
  let admin: Pool;
  let pool: Pool;
  const lines: string[] = [];

  beforeAll(async () => {
    admin = createPool({ url: TEST_DATABASE_URL ?? "", queryTimeoutMs: 10_000, max: 1 });
    await admin.query(`create database "${name}"`);
    const url = new URL(TEST_DATABASE_URL ?? "");
    url.pathname = `/${name}`;
    pool = createPool({ url: url.toString(), queryTimeoutMs: 10_000, max: 4 });
    await migrate(pool);
    configureLogger({ write: (line) => lines.push(line) });
  });

  afterEach(() => {
    lines.length = 0;
  });

  afterAll(async () => {
    configureLogger({ write: () => {} });
    await pool?.end();
    try {
      await admin.query(`drop database if exists "${name}" with (force)`);
    } finally {
      await admin.end();
    }
  });

  interface TestUser {
    id: string;
    uuid: string;
    deviceId: string;
  }

  /** A user of `tier` with one device that holds an upload slot. */
  async function newUser(tier: "free" | "paid"): Promise<TestUser> {
    const { rows } = await pool.query<{ id: string; uuid: string }>("insert into users (tier) values ($1) returning id, uuid", [tier]);
    const user = rows[0]!;
    const device = await pool.query<{ id: string }>(
      "insert into devices (user_id, first_upload_at, first_stored_at) values ($1, now() - interval '90 days', now() - interval '90 days') returning id",
      [user.id],
    );
    return { ...user, deviceId: device.rows[0]!.id };
  }

  /** An upload received `days` ago, with a snapshot unless its parse failed. Answers `uploads.id`. */
  async function upload(user: TestUser, days: number, parsed = true): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `insert into uploads (user_id, device_id, kit, source_id, instance, sha256, content_gzip, kit_version, parse_status, parse_error, received_at)
       values ($1, $2, 'wow', 'saved_variables', $3, $3, '\\x00', '1.0.0', $4, $5, now() - make_interval(days => $6))
       returning id`,
      [user.id, user.deviceId, HEX64, parsed ? "parsed" : "failed", parsed ? null : "bad file", days],
    );
    const id = rows[0]!.id;
    if (parsed) {
      await pool.query(
        `insert into snapshots (user_id, upload_id, kit, flavor, rules, snapshot_at, state)
         values ($1, $2, 'wow', 'classic_era', '{}', now() - make_interval(days => $3), '{}')`,
        [user.id, id, days],
      );
    }
    return id;
  }

  /** The user's uploads, by `id`, with whether each has a snapshot. */
  async function history(user: TestUser): Promise<Record<string, boolean>> {
    const { rows } = await pool.query<{ id: string; snapshot: boolean }>(
      "select up.id, s.id is not null as snapshot from uploads up left join snapshots s on s.upload_id = up.id where up.user_id = $1 order by up.id",
      [user.id],
    );
    return Object.fromEntries(rows.map((row) => [row.id, row.snapshot]));
  }

  function logged(): Record<string, unknown>[] {
    return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("deletes a free user's uploads and snapshots over 30 days old, keeps a paid user's, and logs the counts", async () => {
    const free = await newUser("free");
    const paid = await newUser("paid");
    await upload(free, 31);
    await upload(free, 31, false);
    const recent = await upload(free, 29);
    const paidOld = await upload(paid, 400);

    expect(await deleteExpiredHistory({ pool })).toEqual({ uploads: 2, snapshots: 1 });
    expect(await history(free)).toEqual({ [recent]: true });
    expect(await history(paid)).toEqual({ [paidOld]: true });

    // The device keeps its upload slot (§8.3).
    const { rows } = await pool.query("select first_stored_at < now() - interval '89 days' as kept from devices where id = $1", [free.deviceId]);
    expect(rows[0]).toEqual({ kept: true });

    const entries = logged();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ level: "info", time: expect.any(String), msg: "expired history deleted", uploads: 2, snapshots: 1 });
    expect(lines[0]).not.toContain(free.uuid);
  });

  it("keeps a downgraded user's old history for the grace period, then deletes it (D9)", async () => {
    const user = await newUser("paid");
    const old = await upload(user, 60);
    const recent = await upload(user, 10);
    await pool.query("update users set tier = 'free' where id = $1", [user.id]);
    const changed = await pool.query("select tier_changed_at > now() - interval '1 minute' as set from users where id = $1", [user.id]);
    expect(changed.rows[0]).toEqual({ set: true });

    expect(await deleteExpiredHistory({ pool })).toEqual({ uploads: 0, snapshots: 0 });
    expect(await history(user)).toEqual({ [old]: true, [recent]: true });

    await pool.query("update users set tier_changed_at = now() - interval '31 days' where id = $1", [user.id]);
    expect(await deleteExpiredHistory({ pool })).toEqual({ uploads: 1, snapshots: 1 });
    expect(await history(user)).toEqual({ [recent]: true });
  });

  it("deletes nothing when FREE_RETENTION_DAYS is off", async () => {
    const user = await newUser("free");
    const old = await upload(user, 400);
    expect(await deleteExpiredHistory({ pool, settings: { freeRetentionDays: null, downgradeGraceDays: 30 } })).toEqual({ uploads: 0, snapshots: 0 });
    expect(await history(user)).toEqual({ [old]: true });
    await pool.query("delete from uploads where user_id = $1", [user.id]);
  });

  it("runs in batches, and two runs at once delete each row once and skip a row another transaction holds", async () => {
    const users = [await newUser("free"), await newUser("free")];
    const ids: string[] = [];
    for (const user of users) for (let i = 0; i < 10; i++) ids.push(await upload(user, 40));

    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from uploads where id = $1 for update", [ids[0]]);
      const runs = await Promise.all([deleteExpiredHistory({ pool, batchSize: 3 }), deleteExpiredHistory({ pool, batchSize: 3 })]);
      expect(runs[0]!.uploads + runs[1]!.uploads).toBe(19);
      expect(runs[0]!.snapshots + runs[1]!.snapshots).toBe(19);
      await holder.query("commit");
    } finally {
      holder.release();
    }
    expect(await history(users[0]!)).toEqual({ [ids[0]!]: true });

    expect(await deleteExpiredHistory({ pool, batchSize: 3 })).toEqual({ uploads: 1, snapshots: 1 });
    expect(logged().filter((entry) => entry["level"] !== "info")).toEqual([]);
  });
});
