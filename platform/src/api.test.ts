import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { createPool } from "./db.js";
import { writeAdapterZips } from "./kits/adapter.js";
import { KIT_SOURCES, type KitRegistry, loadKitRegistry } from "./kits/registry.js";
import { checkKits } from "./kits/validate.js";
import { migrate } from "./migrations.js";
import { WebSessions } from "./web-sessions.js";

/** As in migrations.test.ts: a Postgres server whose user may create databases. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"]?.trim() || undefined;
if (TEST_DATABASE_URL === undefined) console.warn("TEST_DATABASE_URL is not set: the Postgres tests in api.test.ts are skipped");

const BASE = "http://localhost:4790";
const DAY_MS = 24 * 60 * 60 * 1000;

let server: Server | undefined;
let adaptersDir: string;
let kits: KitRegistry;

// The real registry, over adapter zips written for these tests.
beforeAll(() => {
  adaptersDir = mkdtempSync(join(tmpdir(), "ogmcp-adapters-"));
  writeAdapterZips(checkKits(KIT_SOURCES), adaptersDir);
  kits = loadKitRegistry({ adaptersDir });
});

afterAll(() => rmSync(adaptersDir, { recursive: true, force: true }));

afterEach(() => {
  server?.close();
  server = undefined;
});

async function serve(pool: Pool, bridgeDownloadUrl?: string, contactEmail?: string): Promise<string> {
  const sessions = new WebSessions({ pool, lifetimeMs: 30 * DAY_MS, renewWithinMs: 15 * DAY_MS, secure: false });
  const auth = { pool, sessions, providers: { google: null, discord: null }, publicBaseUrl: BASE };
  const app = createApp({ health: { checkDatabase: () => Promise.resolve() }, auth, kits, bridgeDownloadUrl, contactEmail });
  server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("without a web session", () => {
  it("GET /api/v1/me answers 401", async () => {
    // No cookie is sent, so nothing queries the database.
    const base = await serve({} as Pool);
    const res = await fetch(`${base}/api/v1/me`);
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "signed_out" });
  });

  it("GET /api/v1/contact answers the contact email, or null when none is configured (§13.2)", async () => {
    const withEmail = await serve({} as Pool, undefined, "privacy@ogmcp.example");
    expect(await (await fetch(`${withEmail}/api/v1/contact`)).json()).toEqual({ email: "privacy@ogmcp.example" });
    server?.close();
    const without = await serve({} as Pool);
    const res = await fetch(`${without}/api/v1/contact`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: null });
  });

  it("GET /api/v1/setup answers 401", async () => {
    const base = await serve({} as Pool, "https://downloads.example/ogmcp-bridge");
    const res = await fetch(`${base}/api/v1/setup`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signed_out" });
  });

  it("the Games API answers 401", async () => {
    const base = await serve({} as Pool);
    const list = await fetch(`${base}/api/v1/games`);
    expect(list.status).toBe(401);
    expect(await list.json()).toEqual({ error: "signed_out" });
    const enable = await fetch(`${base}/api/v1/games/wow`, { method: "PUT", headers: { origin: BASE } });
    expect(enable.status).toBe(401);
    expect(await enable.json()).toEqual({ error: "signed_out" });
  });
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

  /** A new user with a web session: its `users` row and the session cookie. */
  async function signIn(): Promise<{ id: string; uuid: string; cookie: string }> {
    const { rows } = await pool.query<{ id: string; uuid: string }>("insert into users default values returning id, uuid");
    const user = rows[0];
    if (user === undefined) throw new Error("no user row");
    const sessions = new WebSessions({ pool, lifetimeMs: 30 * DAY_MS, renewWithinMs: 15 * DAY_MS, secure: false });
    const { token } = await sessions.create(user.id);
    return { ...user, cookie: `ogmcp_session=${token}` };
  }

  it("GET /api/v1/me answers the signed-in user's uuid and linked providers, and no serial id", async () => {
    const user = await signIn();
    await pool.query(
      "insert into oauth_identities (user_id, provider, provider_user_id) values ($1, 'discord', '100'), ($1, 'google', 'sub-1')",
      [user.id],
    );

    const base = await serve(pool);
    const res = await fetch(`${base}/api/v1/me`, { headers: { cookie: user.cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ uuid: user.uuid, providers: ["discord", "google"] });
  });

  it("GET /api/v1/setup answers the MCP URL, and the download URL only when one is configured (§13.2)", async () => {
    const user = await signIn();
    const configured = await serve(pool, "https://downloads.example/ogmcp-bridge");
    const res = await fetch(`${configured}/api/v1/setup`, { headers: { cookie: user.cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mcp_url: `${BASE}/mcp`, bridge_download_url: "https://downloads.example/ogmcp-bridge" });
    server?.close();

    const unconfigured = await serve(pool);
    expect(await (await fetch(`${unconfigured}/api/v1/setup`, { headers: { cookie: user.cookie } })).json()).toEqual({
      mcp_url: `${BASE}/mcp`,
      bridge_download_url: null,
    });
  });

  it("the Games API enables and disables a kit for the signed-in user (§13.2, §11)", async () => {
    const user = await signIn();
    const base = await serve(pool);
    const url = `${base}/api/v1/games`;
    const list = async () => (await fetch(url, { headers: { cookie: user.cookie } })).json();
    const rows = async () =>
      (await pool.query("select u.uuid, g.kit from user_games g join users u on u.id = g.user_id order by g.id")).rows;

    expect(await list()).toEqual({ games: [{ kit: "wow", name: "World of Warcraft", enabled: false }] });

    // Without this site's Origin, nothing changes.
    const crossSite = await fetch(`${url}/wow`, { method: "PUT", headers: { cookie: user.cookie } });
    expect(crossSite.status).toBe(403);
    expect(await rows()).toEqual([]);

    const headers = { cookie: user.cookie, origin: BASE };
    const enable = await fetch(`${url}/wow`, { method: "PUT", headers });
    expect(enable.status).toBe(200);
    expect(await enable.json()).toEqual({ kit: "wow", name: "World of Warcraft", enabled: true });
    expect((await fetch(`${url}/wow`, { method: "PUT", headers })).status).toBe(200);
    expect(await rows()).toEqual([{ uuid: user.uuid, kit: "wow" }]);
    expect(await list()).toEqual({ games: [{ kit: "wow", name: "World of Warcraft", enabled: true }] });

    const disable = await fetch(`${url}/wow`, { method: "DELETE", headers });
    expect(disable.status).toBe(200);
    expect(await disable.json()).toEqual({ kit: "wow", name: "World of Warcraft", enabled: false });
    expect(await rows()).toEqual([]);
    expect(await list()).toEqual({ games: [{ kit: "wow", name: "World of Warcraft", enabled: false }] });
  });

  it("the Games API answers 404 for a kit the registry does not hold", async () => {
    const user = await signIn();
    const base = await serve(pool);
    const res = await fetch(`${base}/api/v1/games/nope`, { method: "PUT", headers: { cookie: user.cookie, origin: BASE } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_kit" });
    const { rows } = await pool.query("select 1 from user_games where kit = 'nope'");
    expect(rows).toEqual([]);
  });
});
