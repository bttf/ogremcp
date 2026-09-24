import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { createPool } from "./db.js";
import { migrate } from "./migrations.js";
import { WebSessions } from "./web-sessions.js";

/** As in migrations.test.ts: a Postgres server whose user may create databases. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"]?.trim() || undefined;
if (TEST_DATABASE_URL === undefined) console.warn("TEST_DATABASE_URL is not set: the Postgres tests in api.test.ts are skipped");

const BASE = "http://localhost:4790";
const DAY_MS = 24 * 60 * 60 * 1000;

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

async function serve(pool: Pool): Promise<string> {
  const sessions = new WebSessions({ pool, lifetimeMs: 30 * DAY_MS, renewWithinMs: 15 * DAY_MS, secure: false });
  const auth = { pool, sessions, providers: { google: null, discord: null }, publicBaseUrl: BASE };
  server = createServer(createApp({ health: { checkDatabase: () => Promise.resolve() }, auth })).listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("GET /api/v1/me", () => {
  it("answers 401 without a web session", async () => {
    // No cookie is sent, so nothing queries the database.
    const base = await serve({} as Pool);
    const res = await fetch(`${base}/api/v1/me`);
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "signed_out" });
  });

  describe.skipIf(TEST_DATABASE_URL === undefined)("against Postgres", () => {
    const name = `ogmcp_test_${randomBytes(6).toString("hex")}`;
    let admin: Pool;
    let pool: Pool;

    beforeAll(async () => {
      admin = createPool({ url: TEST_DATABASE_URL ?? "", queryTimeoutMs: 10_000, max: 1 });
      await admin.query(`create database "${name}"`);
      const url = new URL(TEST_DATABASE_URL ?? "");
      url.pathname = `/${name}`;
      pool = createPool({ url: url.toString(), queryTimeoutMs: 10_000, max: 4 });
      await migrate(pool);
    });

    afterAll(async () => {
      await pool?.end();
      try {
        await admin.query(`drop database if exists "${name}" with (force)`);
      } finally {
        await admin.end();
      }
    });

    it("answers the signed-in user's uuid and linked providers, and no serial id", async () => {
      const { rows } = await pool.query<{ id: string; uuid: string }>("insert into users default values returning id, uuid");
      const user = rows[0];
      if (user === undefined) throw new Error("no user row");
      await pool.query(
        "insert into oauth_identities (user_id, provider, provider_user_id) values ($1, 'discord', '100'), ($1, 'google', 'sub-1')",
        [user.id],
      );
      const sessions = new WebSessions({ pool, lifetimeMs: 30 * DAY_MS, renewWithinMs: 15 * DAY_MS, secure: false });
      const { token } = await sessions.create(user.id);

      const base = await serve(pool);
      const res = await fetch(`${base}/api/v1/me`, { headers: { cookie: `ogmcp_session=${token}` } });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ uuid: user.uuid, providers: ["discord", "google"] });
    });
  });
});
