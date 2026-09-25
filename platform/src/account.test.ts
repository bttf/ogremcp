import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type Provider from "oidc-provider";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { createPool } from "./db.js";
import { BRIDGE_CLIENT_ID, createDevice } from "./devices.js";
import { writeAdapterZips } from "./kits/adapter.js";
import { KIT_SOURCES, loadKitRegistry } from "./kits/registry.js";
import { checkKits } from "./kits/validate.js";
import { configureLogger } from "./log.js";
import { migrate } from "./migrations.js";
import { createOidcProvider } from "./oidc.js";
import { PostgresAdapter } from "./oidc-adapter.js";
import { generateOidcKeys } from "./oidc-keys.js";
import { resourcesOf } from "./oidc-tokens.js";
import { WebSessions } from "./web-sessions.js";

/** As in migrations.test.ts: a Postgres server whose user may create databases. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"]?.trim() || undefined;
if (TEST_DATABASE_URL === undefined) console.warn("TEST_DATABASE_URL is not set: the Postgres tests in account.test.ts are skipped");

const ISSUER = "http://localhost:4790";
const RESOURCES = resourcesOf(ISSUER);
const AGENT_CLIENT_ID = "test-agent";
const DAY_MS = 24 * 60 * 60 * 1000;

/** `/mcp` passes a token it accepts on to the MCP server. `call` sends no `Accept`, so the server answers 406. */
const MCP_ACCEPTED = 406;

/**
 * The tables whose rows "Delete my data" deletes (§11). `usage_daily` (§14)
 * is not one: it stays, so that the day's tool-call cap does too.
 */
const DATA_TABLES = ["uploads", "snapshots", "events", "issues"];

/**
 * Every table that references `users`. "Delete account" leaves none of their
 * rows for the user, and deletes the user and the user's `oidc_models` rows.
 * A migration that adds a table with a `user_id` fails the last test until
 * the table is named here, and in `DATA_TABLES` when "Delete my data" must
 * delete it too.
 */
const USER_TABLES = [...DATA_TABLES, "oauth_identities", "web_sessions", "devices", "user_games"];

describe.skipIf(TEST_DATABASE_URL === undefined)("Delete my data and Delete account against Postgres (§11)", () => {
  const name = `ogmcp_test_${randomBytes(6).toString("hex")}`;
  let admin: Pool;
  let pool: Pool;
  let provider: Provider;
  let sessions: WebSessions;
  let server: Server | undefined;
  let adaptersDir: string;
  let base: string;
  const lines: string[] = [];

  beforeAll(async () => {
    adaptersDir = mkdtempSync(join(tmpdir(), "ogmcp-adapters-"));
    writeAdapterZips(checkKits(KIT_SOURCES), adaptersDir);
    admin = createPool({ url: TEST_DATABASE_URL ?? "", queryTimeoutMs: 10_000, max: 1 });
    await admin.query(`create database "${name}"`);
    const url = new URL(TEST_DATABASE_URL ?? "");
    url.pathname = `/${name}`;
    pool = createPool({ url: url.toString(), queryTimeoutMs: 10_000, max: 4 });
    await migrate(pool);
    await new PostgresAdapter(pool, "Client").upsert(AGENT_CLIENT_ID, {
      client_id: AGENT_CLIENT_ID,
      redirect_uris: ["https://agent.example/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    provider = createOidcProvider({ pool, issuer: ISSUER, keys: generateOidcKeys(), trustProxyHops: 0, log: () => {} });
    sessions = new WebSessions({ pool, lifetimeMs: 30 * DAY_MS, renewWithinMs: 15 * DAY_MS, secure: false });
    const app = createApp({
      health: { checkDatabase: () => Promise.resolve() },
      auth: { pool, sessions, providers: { google: null, discord: null }, publicBaseUrl: ISSUER, log: () => {} },
      oidc: provider,
      kits: loadKitRegistry({ adaptersDir }),
    });
    server = createServer(app).listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    configureLogger({ write: (line) => lines.push(line) });
  });

  afterEach(() => {
    lines.length = 0;
  });

  afterAll(async () => {
    configureLogger({ write: () => {} });
    server?.close();
    rmSync(adaptersDir, { recursive: true, force: true });
    await pool?.end();
    try {
      await admin.query(`drop database if exists "${name}" with (force)`);
    } finally {
      await admin.end();
    }
  });

  interface Tokens {
    accessToken: string;
    refreshToken: string;
  }

  interface SeededUser {
    id: string;
    uuid: string;
    cookie: string;
    bridge: Tokens;
    agent: Tokens;
  }

  /**
   * A grant of the user's to the bridge or the agent client, as approval
   * leaves it, and tokens from its refresh token. For the bridge it also
   * creates the device. As in devices-agents-api.test.ts.
   */
  async function approve(user: { id: string; uuid: string }, bridge: boolean): Promise<Tokens & { deviceId: string | null }> {
    const client = await provider.Client.find(bridge ? BRIDGE_CLIENT_ID : AGENT_CLIENT_ID);
    if (client === undefined) throw new Error("the test client is missing");
    const resource = bridge ? RESOURCES.bridge : RESOURCES.mcp;
    const scope = bridge ? "ingest" : "read";
    const grant = new provider.Grant({ accountId: user.uuid, clientId: client.clientId });
    grant.addResourceScope(resource, scope);
    const grantId = await grant.save();
    let deviceId: string | null = null;
    if (bridge) {
      const deviceUuid = await createDevice(pool, user.id, grantId);
      deviceId = (await pool.query<{ id: string }>("select id from devices where uuid = $1", [deviceUuid])).rows[0]?.id ?? null;
    }
    const gty = bridge ? "device_code" : "authorization_code";
    const first = await new provider.RefreshToken({ accountId: user.uuid, client, grantId, gty, scope, resource }).save();
    const body = await refresh(client.clientId, first);
    const accessToken = body["access_token"];
    const refreshToken = body["refresh_token"];
    if (typeof accessToken !== "string" || typeof refreshToken !== "string") throw new Error(`no tokens: ${JSON.stringify(body)}`);
    return { accessToken, refreshToken, deviceId };
  }

  async function refresh(clientId: string, refreshToken: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${base}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({ client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken }),
    });
    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * A user with a row in every table that references users, a bridge and an
   * agent with live tokens, and an OAuth session and interaction.
   */
  async function seedUser(): Promise<SeededUser> {
    const { rows } = await pool.query<{ id: string; uuid: string }>("insert into users default values returning id, uuid");
    const user = rows[0];
    if (user === undefined) throw new Error("no user row");
    const cookie = `ogmcp_session=${(await sessions.create(user.id)).token}`;
    await pool.query("insert into oauth_identities (user_id, provider, provider_user_id) values ($1, 'google', $2)", [user.id, user.uuid]);
    await pool.query("insert into user_games (user_id, kit) values ($1, 'wow')", [user.id]);
    const bridge = await approve(user, true);
    const agent = await approve(user, false);
    const hex = () => randomBytes(32).toString("hex");
    const { rows: uploads } = await pool.query<{ id: string }>(
      `insert into uploads (user_id, device_id, kit, source_id, instance, sha256, content_gzip, mtime, kit_version, adapter_schema, parse_status)
       values ($1, $2, 'wow', 'savedvariables', $3, $4, '\\x00', now(), '1.0.0', 1, 'parsed') returning id`,
      [user.id, bridge.deviceId, hex(), hex()],
    );
    await pool.query(
      `insert into snapshots (user_id, upload_id, kit, flavor, rules, snapshot_at, state)
       values ($1, $2, 'wow', 'classic_era', '{}', now(), '{}')`,
      [user.id, uploads[0]?.id],
    );
    await pool.query(
      `insert into events (user_id, occurred_at, kind, latency_ms, agent_client, tool, query)
       values ($1, now(), 'tool_call', 5, $2, 'search_game_info', 'where is hogger')`,
      [user.id, AGENT_CLIENT_ID],
    );
    await pool.query(
      "insert into events (user_id, occurred_at, kind, latency_ms, device_id, status) values ($1, now(), 'ingest', 5, $2, 'stored')",
      [user.id, bridge.deviceId],
    );
    await pool.query(
      "insert into issues (user_id, kit, note, agent_client, calls) values ($1, 'wow', 'The route was wrong.', $2, '[]')",
      [user.id, AGENT_CLIENT_ID],
    );
    const sessionId = randomBytes(16).toString("hex");
    await new PostgresAdapter(pool, "Session").upsert(sessionId, { accountId: user.uuid, uid: sessionId, loginTs: 1 }, 3600);
    await new PostgresAdapter(pool, "Interaction").upsert(randomBytes(16).toString("hex"), { session: { accountId: user.uuid, uid: sessionId } }, 3600);
    return { ...user, cookie, bridge, agent };
  }

  /** The user's rows in each table that references users, and in `users` and `oidc_models`. */
  async function rowCounts(user: { id: string; uuid: string }): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const table of USER_TABLES) {
      const { rows } = await pool.query<{ count: number }>(`select count(*)::int as count from ${table} where user_id = $1`, [user.id]);
      counts[table] = rows[0]?.count ?? -1;
    }
    const count = async (sql: string, param: string) => (await pool.query<{ count: number }>(sql, [param])).rows[0]?.count ?? -1;
    counts["users"] = await count("select count(*)::int as count from users where id = $1", user.id);
    // Every row whose payload names the user, whatever its model.
    counts["oidc_models"] = await count("select count(*)::int as count from oidc_models where strpos(payload::text, $1) > 0", user.uuid);
    return counts;
  }

  /** A request with an access token and the issuer's Host, which `/mcp` checks. `fetch` cannot set it. */
  async function call(method: "GET" | "POST", path: string, accessToken: string): Promise<number> {
    const { port } = new URL(base);
    return new Promise((resolve, reject) => {
      const headers = { host: new URL(ISSUER).host, authorization: `Bearer ${accessToken}` };
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end();
    });
  }

  async function del(user: { cookie: string }, path: string, origin: string | null = ISSUER): Promise<Response> {
    const headers: Record<string, string> = { cookie: user.cookie };
    if (origin !== null) headers["origin"] = origin;
    return fetch(`${base}${path}`, { method: "DELETE", headers });
  }

  function logged(msg: string): Record<string, unknown>[] {
    return lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line["msg"] === msg);
  }

  it("Delete my data deletes the user's data only; the account, devices, and agents go on working", async () => {
    const user = await seedUser();
    const other = await seedUser();
    const before = await rowCounts(user);
    const otherBefore = await rowCounts(other);
    for (const table of USER_TABLES) expect(before[table], table).toBeGreaterThan(0);

    expect((await del(user, "/api/v1/account/data", null)).status).toBe(403);
    expect(await rowCounts(user)).toEqual(before);

    expect((await del(user, "/api/v1/account/data")).status).toBe(204);
    const after = await rowCounts(user);
    for (const table of DATA_TABLES) expect(after[table], table).toBe(0);
    expect(after).toEqual({ ...before, uploads: 0, snapshots: 0, events: 0, issues: 0 });
    expect(await rowCounts(other)).toEqual(otherBefore);

    expect(logged("user data deleted")).toEqual([
      expect.objectContaining({ user_uuid: user.uuid, issues: 1, events: 2, snapshots: 1, uploads: 1 }),
    ]);

    expect((await fetch(`${base}/api/v1/me`, { headers: { cookie: user.cookie } })).status).toBe(200);
    expect(await call("GET", "/api/v1/kits", user.bridge.accessToken)).toBe(200);
    expect(await call("POST", "/mcp", user.agent.accessToken)).toBe(MCP_ACCEPTED);
  });

  it("Delete account leaves no row of the user, signs the user out, and every bridge and agent token gets 401", async () => {
    const user = await seedUser();
    const other = await seedUser();
    const otherBefore = await rowCounts(other);
    expect(await call("GET", "/api/v1/kits", user.bridge.accessToken)).toBe(200);
    expect(await call("POST", "/mcp", user.agent.accessToken)).toBe(MCP_ACCEPTED);

    expect((await del(user, "/api/v1/account", null)).status).toBe(403);
    expect((await rowCounts(user))["users"]).toBe(1);

    const res = await del(user, "/api/v1/account");
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toMatch(/^ogmcp_session=;/);
    const after = await rowCounts(user);
    expect(after).toEqual(Object.fromEntries(Object.keys(after).map((table) => [table, 0])));
    expect(await rowCounts(other)).toEqual(otherBefore);

    expect(logged("account deleted")).toEqual([
      expect.objectContaining({
        user_uuid: user.uuid,
        issues: 1,
        events: 2,
        snapshots: 1,
        uploads: 1,
        web_sessions: 1,
        oauth_identities: 1,
        user_games: 1,
        devices: 1,
        users: 1,
      }),
    ]);

    expect((await fetch(`${base}/api/v1/me`, { headers: { cookie: user.cookie } })).status).toBe(401);
    expect(await call("GET", "/api/v1/kits", user.bridge.accessToken)).toBe(401);
    expect(await call("POST", "/mcp", user.agent.accessToken)).toBe(401);
    expect((await refresh(BRIDGE_CLIENT_ID, user.bridge.refreshToken))["error"]).toBe("invalid_grant");
    expect((await refresh(AGENT_CLIENT_ID, user.agent.refreshToken))["error"]).toBe("invalid_grant");
    expect(await call("GET", "/api/v1/kits", other.bridge.accessToken)).toBe(200);
    expect(await call("POST", "/mcp", other.agent.accessToken)).toBe(MCP_ACCEPTED);
  });

  it("names every table that references users", async () => {
    const { rows } = await pool.query<{ table: string }>(
      `select distinct c.conrelid::regclass::text as table
         from pg_constraint c
        where c.contype = 'f' and c.confrelid = 'users'::regclass
        order by 1`,
    );
    expect(rows.map((row) => row.table)).toEqual([...USER_TABLES].sort());
  });
});
