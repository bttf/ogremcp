import { randomBytes } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteExpiredAuthRows } from "./auth-cleanup.js";
import { createPool } from "./db.js";
import { configureLogger } from "./log.js";
import { migrate } from "./migrations.js";

/** As in migrations.test.ts: a Postgres server whose user may create databases. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"]?.trim() || undefined;
if (TEST_DATABASE_URL === undefined) console.warn("TEST_DATABASE_URL is not set: the Postgres tests in auth-cleanup.test.ts are skipped");

describe.skipIf(TEST_DATABASE_URL === undefined)("expired auth row cleanup against Postgres (§11)", () => {
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

  afterAll(async () => {
    configureLogger({ write: () => {} });
    await pool?.end();
    try {
      await admin.query(`drop database if exists "${name}" with (force)`);
    } finally {
      await admin.end();
    }
  });

  /** An oidc_models row that expires `seconds` from now, or never when null. */
  async function oidcRow(model: string, oidcId: string, seconds: number | null): Promise<void> {
    await pool.query(
      `insert into oidc_models (model, oidc_id, payload, expires_at)
       values ($1, $2, '{}', now() + make_interval(secs => $3::double precision))`,
      [model, oidcId, seconds],
    );
  }

  /** A web session that expires `seconds` from now. */
  async function webSession(userId: string, seconds: number): Promise<void> {
    await pool.query("insert into web_sessions (user_id, token_hash, expires_at) values ($1, $2, now() + make_interval(secs => $3))", [
      userId,
      randomBytes(32),
      seconds,
    ]);
  }

  it("deletes expired OAuth rows and web sessions in batches, keeps live rows and rows without an expiry, and logs the counts", async () => {
    await oidcRow("AccessToken", "expired-1", -60);
    await oidcRow("RefreshToken", "expired-2", -3600);
    await oidcRow("Session", "expired-3", -1);
    await oidcRow("AccessToken", "live", 3600);
    await oidcRow("Client", "client", null);
    const { rows } = await pool.query<{ id: string }>("insert into users (tier) values ('free') returning id");
    const userId = rows[0]!.id;
    await webSession(userId, -60);
    await webSession(userId, -86_400);
    await webSession(userId, 3600);

    expect(await deleteExpiredAuthRows({ pool, batchSize: 2 })).toEqual({ oidc_models: 3, web_sessions: 2 });

    const oidc = await pool.query<{ oidc_id: string }>("select oidc_id from oidc_models order by oidc_id");
    expect(oidc.rows.map((row) => row.oidc_id)).toEqual(["client", "live"]);
    const sessions = await pool.query<{ live: boolean }>("select expires_at > now() as live from web_sessions");
    expect(sessions.rows).toEqual([{ live: true }]);

    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { level: "info", time: expect.any(String), msg: "expired auth rows deleted", oidc_models: 3, web_sessions: 2 },
    ]);
  });
});
