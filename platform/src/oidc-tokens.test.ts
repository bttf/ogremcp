import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express, { type RequestHandler } from "express";
import type Provider from "oidc-provider";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool } from "./db.js";
import { migrate } from "./migrations.js";
import { createOidcProvider, mountOidc } from "./oidc.js";
import { PostgresAdapter } from "./oidc-adapter.js";
import { generateOidcKeys } from "./oidc-keys.js";
import { currentToken, requireToken, resourcesOf, type Scope } from "./oidc-tokens.js";
import { WebSessions } from "./web-sessions.js";

/** As in migrations.test.ts: a Postgres server whose user may create databases. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"]?.trim() || undefined;
if (TEST_DATABASE_URL === undefined) console.warn("TEST_DATABASE_URL is not set: the Postgres tests in oidc-tokens.test.ts are skipped");

const ISSUER = "http://localhost:4790";
const RESOURCES = resourcesOf(ISSUER);
const RESOURCE_METADATA = `${ISSUER}/.well-known/oauth-protected-resource/mcp`;
const CLIENT_ID = "test-client";
const REDIRECT_URI = "https://agent.example/callback";
const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(TEST_DATABASE_URL === undefined)("OAuth tokens against Postgres", () => {
  const name = `ogmcp_test_${randomBytes(6).toString("hex")}`;
  let admin: Pool;
  let pool: Pool;
  let provider: Provider;
  let server: Server | undefined;
  let base: string;

  beforeAll(async () => {
    admin = createPool({ url: TEST_DATABASE_URL ?? "", queryTimeoutMs: 10_000, max: 1 });
    await admin.query(`create database "${name}"`);
    const url = new URL(TEST_DATABASE_URL ?? "");
    url.pathname = `/${name}`;
    pool = createPool({ url: url.toString(), queryTimeoutMs: 10_000, max: 4 });
    await migrate(pool);
    // Client registration is RED-304, RED-305, and RED-306.
    await new PostgresAdapter(pool, "Client").upsert(CLIENT_ID, {
      client_id: CLIENT_ID,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    provider = createOidcProvider({ pool, issuer: ISSUER, keys: generateOidcKeys(), trustProxyHops: 0, log: () => {} });
    // Stand-ins for the MCP server (RED-325) and the ingest endpoint (RED-313).
    const app = express();
    app.use(new WebSessions({ pool, lifetimeMs: DAY_MS, renewWithinMs: DAY_MS, secure: false }).middleware());
    mountOidc(app, provider, pool);
    const answer: RequestHandler = (_req, res) => {
      res.json(currentToken(res));
    };
    const challenge = { resource_metadata: RESOURCE_METADATA };
    app.get("/mcp", requireToken({ provider, resource: RESOURCES.mcp, scope: "read", challenge }), answer);
    app.post("/api/v1/ingest", requireToken({ provider, resource: RESOURCES.bridge, scope: "ingest" }), answer);
    server = createServer(app).listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.close();
    await pool?.end();
    try {
      await admin.query(`drop database if exists "${name}" with (force)`);
    } finally {
      await admin.end();
    }
  });

  /**
   * A new user's grant of `scope` on `resource`, and a refresh token of it, as
   * an approval leaves them. The consent page is RED-303 and the device flow
   * RED-307.
   */
  async function approve(resource: string, scope: Scope): Promise<{ userUuid: string; grantId: string; refreshToken: string }> {
    const { rows } = await pool.query<{ uuid: string }>("insert into users default values returning uuid");
    const userUuid = rows[0]?.uuid ?? "";
    const client = await provider.Client.find(CLIENT_ID);
    if (client === undefined) throw new Error("the test client is missing");
    const grant = new provider.Grant({ accountId: userUuid, clientId: CLIENT_ID });
    grant.addResourceScope(resource, scope);
    const grantId = await grant.save();
    const refreshToken = await new provider.RefreshToken({ accountId: userUuid, client, grantId, gty: "authorization_code", scope, resource }).save();
    return { userUuid, grantId, refreshToken };
  }

  async function post(path: string, params: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${base}${path}`, { method: "POST", body: new URLSearchParams({ client_id: CLIENT_ID, ...params }) });
    const text = await res.text();
    return { status: res.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  /** The token endpoint's answer to a refresh token. */
  async function refresh(refreshToken: string): Promise<{ status: number; body: Record<string, unknown> }> {
    return post("/oauth/token", { grant_type: "refresh_token", refresh_token: refreshToken });
  }

  async function call(method: "GET" | "POST", path: string, token?: string): Promise<Response> {
    return fetch(`${base}${path}`, { method, headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });
  }

  it("accepts a read token only at /mcp and an ingest token only at the bridge API", async () => {
    const agent = await approve(RESOURCES.mcp, "read");
    const read = await refresh(agent.refreshToken);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ token_type: "Bearer", scope: "read", expires_in: 3600 });
    expect(read.body["refresh_token"]).not.toBe(agent.refreshToken);
    const readToken = String(read.body["access_token"]);

    const atMcp = await call("GET", "/mcp", readToken);
    expect(atMcp.status).toBe(200);
    expect(await atMcp.json()).toEqual({ userUuid: agent.userUuid, clientId: CLIENT_ID, grantId: agent.grantId, scopes: ["read"] });
    const readAtIngest = await call("POST", "/api/v1/ingest", readToken);
    expect(readAtIngest.status).toBe(401);
    expect(readAtIngest.headers.get("www-authenticate")).toMatch(/^Bearer error="invalid_token", .*scope="ingest"$/);

    const bridge = await approve(RESOURCES.bridge, "ingest");
    const ingest = await refresh(bridge.refreshToken);
    expect(ingest.body).toMatchObject({ scope: "ingest" });
    const ingestToken = String(ingest.body["access_token"]);
    expect((await call("POST", "/api/v1/ingest", ingestToken)).status).toBe(200);
    const ingestAtMcp = await call("GET", "/mcp", ingestToken);
    expect(ingestAtMcp.status).toBe(401);
    expect(ingestAtMcp.headers.get("www-authenticate")).toMatch(/^Bearer error="invalid_token", .*resource_metadata=/);

    // No token: a challenge without an error code, with the route's params.
    const none = await call("GET", "/mcp");
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe(`Bearer scope="read", resource_metadata="${RESOURCE_METADATA}"`);

    // A token for /mcp without the read scope.
    const client = await provider.Client.find(CLIENT_ID);
    if (client === undefined) throw new Error("the test client is missing");
    const scopeless = await new provider.AccessToken({
      accountId: agent.userUuid,
      client,
      grantId: agent.grantId,
      gty: "authorization_code",
      resourceServer: new provider.ResourceServer(RESOURCES.mcp, { scope: "read" }),
    }).save();
    const forbidden = await call("GET", "/mcp", scopeless);
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("www-authenticate")).toMatch(/^Bearer error="insufficient_scope", .*scope="read"/);
  });

  it("refuses an agent's sign-in that asks for ingest or the bridge API, before consent", async () => {
    /** Where an authorization request sends the browser. */
    async function authorize(params: Record<string, string>): Promise<URL> {
      const query = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        code_challenge: createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url"),
        code_challenge_method: "S256",
        ...params,
      });
      const res = await fetch(`${base}/oauth/authorize?${query}`, { redirect: "manual" });
      return new URL(res.headers.get("location") ?? "", base);
    }
    const error = (url: URL) => (url.origin === new URL(REDIRECT_URI).origin ? url.searchParams.get("error") : url.pathname);
    expect(error(await authorize({ scope: "ingest", resource: RESOURCES.bridge }))).toBe("invalid_target");
    expect(error(await authorize({ scope: "read", resource: RESOURCES.bridge }))).toBe("invalid_target");
    expect(error(await authorize({ scope: "read ingest", resource: RESOURCES.mcp }))).toBe("invalid_scope");
    expect(error(await authorize({ scope: "ingest" }))).toBe("invalid_scope");
    // The allowed request goes on to sign-in and consent.
    expect(error(await authorize({ scope: "openid offline_access read", resource: RESOURCES.mcp }))).toMatch(/^\/interaction\//);
  });

  it("refuses an expired access token", async () => {
    const agent = await approve(RESOURCES.mcp, "read");
    const token = String((await refresh(agent.refreshToken)).body["access_token"]);
    expect((await call("GET", "/mcp", token)).status).toBe(200);
    // Only the payload's expiry: the row stays, so the check is not the adapter's.
    await pool.query(
      `update oidc_models set payload = jsonb_set(payload, '{exp}', to_jsonb(floor(extract(epoch from now()))::bigint - 1))
        where model = 'AccessToken' and oidc_id = $1`,
      [token],
    );
    const expired = await call("GET", "/mcp", token);
    expect(expired.status).toBe(401);
    expect(expired.headers.get("www-authenticate")).toMatch(/^Bearer error="invalid_token"/);
  });

  it("revokes the grant when its refresh token is revoked at /oauth/revoke", async () => {
    const agent = await approve(RESOURCES.mcp, "read");
    const tokens = await refresh(agent.refreshToken);
    const accessToken = String(tokens.body["access_token"]);
    const refreshToken = String(tokens.body["refresh_token"]);
    expect((await call("GET", "/mcp", accessToken)).status).toBe(200);

    expect((await post("/oauth/revoke", { token: refreshToken, token_type_hint: "refresh_token" })).status).toBe(200);
    expect(await refresh(refreshToken)).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    expect((await call("GET", "/mcp", accessToken)).status).toBe(401);
  });
});
