import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type Provider from "oidc-provider";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { createPool } from "./db.js";
import { BRIDGE_CLIENT_ID, createDevice } from "./devices.js";
import { writeAdapterZips } from "./kits/adapter.js";
import { KIT_SOURCES, loadKitRegistry } from "./kits/registry.js";
import { checkKits } from "./kits/validate.js";
import { migrate } from "./migrations.js";
import { createOidcProvider } from "./oidc.js";
import { PostgresAdapter } from "./oidc-adapter.js";
import { generateOidcKeys } from "./oidc-keys.js";
import { resourcesOf } from "./oidc-tokens.js";
import { WebSessions } from "./web-sessions.js";

/** As in migrations.test.ts: a Postgres server whose user may create databases. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"]?.trim() || undefined;
if (TEST_DATABASE_URL === undefined) console.warn("TEST_DATABASE_URL is not set: the Postgres tests in devices-agents-api.test.ts are skipped");

const ISSUER = "http://localhost:4790";
const RESOURCES = resourcesOf(ISSUER);
const AGENT_CLIENT_ID = "test-agent";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `/mcp` passes a token it accepts on to the MCP server. `call` sends no
 * `Accept`, so the server answers 406.
 */
const MCP_ACCEPTED = 406;

describe.skipIf(TEST_DATABASE_URL === undefined)("the Devices and Connected agents API against Postgres (§13.2)", () => {
  const name = `ogremcp_test_${randomBytes(6).toString("hex")}`;
  let admin: Pool;
  let pool: Pool;
  let provider: Provider;
  let sessions: WebSessions;
  let server: Server | undefined;
  let adaptersDir: string;
  let base: string;
  /** Every outgoing fetch the OAuth server made. */
  const fetched: string[] = [];

  beforeAll(async () => {
    adaptersDir = mkdtempSync(join(tmpdir(), "ogremcp-adapters-"));
    writeAdapterZips(checkKits(KIT_SOURCES), adaptersDir);
    admin = createPool({ url: TEST_DATABASE_URL ?? "", queryTimeoutMs: 10_000, max: 1 });
    await admin.query(`create database "${name}"`);
    const url = new URL(TEST_DATABASE_URL ?? "");
    url.pathname = `/${name}`;
    pool = createPool({ url: url.toString(), queryTimeoutMs: 10_000, max: 4 });
    await migrate(pool);
    // An agent client, as dynamic registration stores one.
    await new PostgresAdapter(pool, "Client").upsert(AGENT_CLIENT_ID, {
      client_id: AGENT_CLIENT_ID,
      client_name: "Test agent",
      redirect_uris: ["https://agent.example/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    provider = createOidcProvider({
      pool,
      issuer: ISSUER,
      keys: generateOidcKeys(),
      trustProxyHops: 0,
      log: () => {},
      testOnlyFetch: (input) => {
        fetched.push(input instanceof Request ? input.url : String(input));
        return Promise.resolve(new Response(null, { status: 404 }));
      },
    });
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
  });

  afterAll(async () => {
    server?.close();
    rmSync(adaptersDir, { recursive: true, force: true });
    await pool?.end();
    try {
      await admin.query(`drop database if exists "${name}" with (force)`);
    } finally {
      await admin.end();
    }
  });

  /** A new user with a web session. */
  async function signIn(): Promise<{ id: string; uuid: string; cookie: string }> {
    const { rows } = await pool.query<{ id: string; uuid: string }>("insert into users default values returning id, uuid");
    const user = rows[0];
    if (user === undefined) throw new Error("no user row");
    return { ...user, cookie: `ogremcp_session=${(await sessions.create(user.id)).token}` };
  }

  /**
   * A grant of the user's to the bridge or the agent client, as approval
   * leaves it, and an access token from its refresh token. For the bridge
   * it also creates the device. The approvals are `devices.test.ts` and
   * `oidc.test.ts`.
   */
  async function approve(
    user: { id: string; uuid: string },
    bridge: boolean,
  ): Promise<{ grantId: string; accessToken: string; refreshToken: string; deviceUuid: string | null }> {
    const client = await provider.Client.find(bridge ? BRIDGE_CLIENT_ID : AGENT_CLIENT_ID);
    if (client === undefined) throw new Error("the test client is missing");
    const resource = bridge ? RESOURCES.bridge : RESOURCES.mcp;
    const scope = bridge ? "ingest" : "read";
    const grant = new provider.Grant({ accountId: user.uuid, clientId: client.clientId });
    grant.addResourceScope(resource, scope);
    const grantId = await grant.save();
    const deviceUuid = bridge ? await createDevice(pool, user.id, grantId) : null;
    const gty = bridge ? "device_code" : "authorization_code";
    const first = await new provider.RefreshToken({ accountId: user.uuid, client, grantId, gty, scope, resource }).save();
    const res = await fetch(`${base}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({ client_id: client.clientId, grant_type: "refresh_token", refresh_token: first }),
    });
    const body = (await res.json()) as Record<string, string>;
    const accessToken = body["access_token"];
    const refreshToken = body["refresh_token"];
    if (accessToken === undefined || refreshToken === undefined) throw new Error(`no tokens: ${JSON.stringify(body)}`);
    return { grantId, accessToken, refreshToken, deviceUuid };
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

  async function api(
    user: { cookie: string },
    method: "GET" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    origin: string | null = ISSUER,
  ): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = { cookie: user.cookie };
    if (origin !== null) headers["origin"] = origin;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = res.headers.get("content-type")?.startsWith("application/json") === true;
    return { status: res.status, body: json ? ((await res.json()) as unknown) : null };
  }

  it("lists, renames, and revokes the user's own devices only; a revoked device's token fails at /api/v1/kits", async () => {
    const user = await signIn();
    const other = await signIn();
    const own = await approve(user, true);
    const theirs = await approve(other, true);
    const ownPath = `/api/v1/devices/${own.deviceUuid}`;
    const theirPath = `/api/v1/devices/${theirs.deviceUuid}`;

    const listed = await api(user, "GET", "/api/v1/devices");
    expect(listed.body).toEqual({
      devices: [
        {
          uuid: own.deviceUuid,
          name: null,
          os: null,
          bridge_version: null,
          approved_at: expect.any(String),
          last_seen_at: null,
          revoked: false,
        },
      ],
    });

    // Trimmed, bounded, and an empty name resets it.
    expect(await api(user, "PATCH", ownPath, { name: "  Gaming PC  " })).toMatchObject({ status: 200, body: { name: "Gaming PC" } });
    expect(await api(user, "PATCH", ownPath, { name: "x".repeat(65) })).toEqual({ status: 400, body: { error: "invalid_name" } });
    expect(await api(user, "PATCH", ownPath, { name: "   " })).toMatchObject({ status: 200, body: { name: null } });
    expect((await api(user, "PATCH", ownPath, { name: "Laptop" }, null)).status).toBe(403);
    expect((await api(user, "DELETE", ownPath, undefined, null)).status).toBe(403);

    // Another user's device is not found, and stays as it was.
    expect(await api(user, "PATCH", theirPath, { name: "Mine now" })).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await api(user, "DELETE", theirPath)).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await api(user, "DELETE", "/api/v1/devices/1")).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await api(other, "GET", "/api/v1/devices")).toMatchObject({ body: { devices: [{ uuid: theirs.deviceUuid, name: null, revoked: false }] } });
    expect(await call("GET", "/api/v1/kits", theirs.accessToken)).toBe(200);

    expect(await call("GET", "/api/v1/kits", own.accessToken)).toBe(200);
    expect(await api(user, "DELETE", ownPath)).toMatchObject({ status: 200, body: { uuid: own.deviceUuid, revoked: true } });
    expect(await call("GET", "/api/v1/kits", own.accessToken)).toBe(401);
    expect(await api(user, "DELETE", ownPath)).toMatchObject({ status: 200, body: { revoked: true } });
  });

  it("shows a device whose bridge revoked its own refresh token as revoked", async () => {
    const user = await signIn();
    const device = await approve(user, true);
    const res = await fetch(`${base}/oauth/revoke`, {
      method: "POST",
      body: new URLSearchParams({ client_id: BRIDGE_CLIENT_ID, token: device.refreshToken, token_type_hint: "refresh_token" }),
    });
    expect(res.status).toBe(200);
    expect(await api(user, "GET", "/api/v1/devices")).toMatchObject({ body: { devices: [{ uuid: device.deviceUuid, revoked: true }] } });
    const { rows } = await pool.query("select revoked_at from devices where uuid = $1", [device.deviceUuid]);
    expect(rows).toEqual([{ revoked_at: null }]);
  });

  it("lists and revokes the user's own agent grants only, never the bridge's; a revoked grant's token fails at /mcp", async () => {
    const user = await signIn();
    const other = await signIn();
    const own = await approve(user, false);
    const bridge = await approve(user, true);
    const theirs = await approve(other, false);
    const idOf = async (grantId: string): Promise<string> =>
      (await pool.query<{ uuid: string }>("select uuid from oidc_models where model = 'Grant' and oidc_id = $1", [grantId])).rows[0]?.uuid ?? "";
    const ownId = await idOf(own.grantId);

    expect(await api(user, "GET", "/api/v1/agents")).toEqual({
      status: 200,
      body: {
        agents: [
          {
            id: ownId,
            client_id: AGENT_CLIENT_ID,
            client_name: "Test agent",
            client_host: null,
            approved_at: expect.any(String),
            last_used_at: expect.any(String),
          },
        ],
      },
    });

    // The bridge's grant is a device, and another user's grant is not found.
    expect(await api(user, "DELETE", `/api/v1/agents/${await idOf(bridge.grantId)}`)).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await api(user, "DELETE", `/api/v1/agents/${await idOf(theirs.grantId)}`)).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await call("GET", "/api/v1/kits", bridge.accessToken)).toBe(200);
    expect(await call("POST", "/mcp", theirs.accessToken)).toBe(MCP_ACCEPTED);
    expect((await api(user, "DELETE", `/api/v1/agents/${ownId}`, undefined, null)).status).toBe(403);

    expect(await call("POST", "/mcp", own.accessToken)).toBe(MCP_ACCEPTED);
    expect(await api(user, "DELETE", `/api/v1/agents/${ownId}`)).toEqual({ status: 204, body: null });
    expect(await call("POST", "/mcp", own.accessToken)).toBe(401);
    const refreshed = await fetch(`${base}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({ client_id: AGENT_CLIENT_ID, grant_type: "refresh_token", refresh_token: own.refreshToken }),
    });
    expect(((await refreshed.json()) as Record<string, unknown>)["error"]).toBe("invalid_grant");
    expect(await api(user, "GET", "/api/v1/agents")).toEqual({ status: 200, body: { agents: [] } });

    // "Last used" is the grant's own, and outlives its access tokens, which the cleanup deletes once expired (§11).
    await pool.query("delete from oidc_models where model = 'AccessToken' and grant_id = $1", [theirs.grantId]);
    expect(await api(other, "GET", "/api/v1/agents")).toMatchObject({ body: { agents: [{ last_used_at: expect.any(String) }] } });
  });

  it("lists an agent whose CIMD document is not cached by its host, and fetches nothing", async () => {
    const user = await signIn();
    const clientId = "https://agent.example/oauth/client.json";
    const grant = new provider.Grant({ accountId: user.uuid, clientId });
    grant.addResourceScope(RESOURCES.mcp, "read");
    await grant.save();
    expect(await api(user, "GET", "/api/v1/agents")).toMatchObject({
      status: 200,
      body: { agents: [{ client_id: clientId, client_name: null, client_host: "agent.example" }] },
    });
    expect(fetched).toEqual([]);
  });
});
