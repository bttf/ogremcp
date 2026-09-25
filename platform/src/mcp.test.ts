import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type Provider from "oidc-provider";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { createPool } from "./db.js";
import { MAX_MCP_BODY_BYTES } from "./mcp.js";
import { migrate } from "./migrations.js";
import { createOidcProvider } from "./oidc.js";
import { PostgresAdapter } from "./oidc-adapter.js";
import { generateOidcKeys } from "./oidc-keys.js";
import { WebSessions } from "./web-sessions.js";

/** As in migrations.test.ts: a Postgres server whose user may create databases. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"]?.trim() || undefined;
if (TEST_DATABASE_URL === undefined) console.warn("TEST_DATABASE_URL is not set: the Postgres tests in mcp.test.ts are skipped");

const ISSUER = "https://ogmcp.example";
const DAY_MS = 24 * 60 * 60 * 1000;

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

/**
 * The app on a free port. Without a pool, no request may send a cookie or
 * reach a model, because nothing may query the database.
 */
async function serve(
  pool = {} as Pool,
  oidc = createOidcProvider({ pool, issuer: ISSUER, keys: generateOidcKeys(), trustProxyHops: 1, log: () => {} }),
): Promise<number> {
  const sessions = new WebSessions({ pool, lifetimeMs: DAY_MS, renewWithinMs: DAY_MS, secure: true });
  const app = createApp({
    health: { checkDatabase: () => Promise.resolve() },
    auth: { pool, sessions, providers: { google: null, discord: null }, publicBaseUrl: ISSUER },
    oidc,
    trustProxyHops: 1,
  });
  server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

const INITIALIZE = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}';

/** A request as Railway's edge forwards it: the public Host, and https in X-Forwarded-Proto. A POST sends `body`. */
async function send(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body: string | undefined = method === "POST" ? INITIALIZE : undefined,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: { host: "ogmcp.example", "x-forwarded-proto": "https", accept: "application/json, text/event-stream", ...headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const CHALLENGE = `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp", scope="read"`;

describe("MCP discovery", () => {
  it("serves the protected resource metadata at both paths, with CORS", async () => {
    const port = await serve();
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const res = await send(port, "GET", path, { origin: "https://inspector.example" });
      expect(res.status).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe("*");
      expect(JSON.parse(res.body)).toEqual({
        resource: `${ISSUER}/mcp`,
        authorization_servers: [ISSUER],
        scopes_supported: ["read"],
        bearer_methods_supported: ["header"],
      });
    }
    const preflight = await send(port, "OPTIONS", "/.well-known/oauth-protected-resource/mcp", {
      origin: "https://inspector.example",
      "access-control-request-method": "GET",
      "access-control-request-headers": "mcp-protocol-version",
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("*");
    expect(preflight.headers["access-control-allow-headers"]).toBe("mcp-protocol-version");
  });

  it("serves oidc-provider's authorization server metadata at both paths, with CORS", async () => {
    const port = await serve();
    const openid = await send(port, "GET", "/.well-known/openid-configuration");
    const oauth = await send(port, "GET", "/.well-known/oauth-authorization-server", { origin: "https://inspector.example" });
    expect(oauth.status).toBe(200);
    expect(oauth.headers["access-control-allow-origin"]).toBe("https://inspector.example");
    const metadata = JSON.parse(oauth.body) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      code_challenge_methods_supported: ["S256"],
    });
    expect(metadata).toEqual(JSON.parse(openid.body));
  });
});

describe("/mcp", () => {
  it("answers a request without a bearer token with 401 and the challenge, and a malformed one with invalid_token", async () => {
    const port = await serve();
    for (const method of ["POST", "GET", "DELETE"]) {
      const res = await send(port, method, "/mcp", { "content-type": "application/json" });
      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toBe(CHALLENGE);
    }
    // Not a bearer token.
    const basic = await send(port, "POST", "/mcp", { authorization: "Basic dXNlcjpwYXNz" });
    expect(basic.status).toBe(401);
    expect(basic.headers["www-authenticate"]).toBe(CHALLENGE);
    // Not a token at all, so nothing is looked up. Tokens that are looked up: oidc-tokens.test.ts.
    const malformed = await send(port, "POST", "/mcp", { authorization: "Bearer not a token", "content-type": "application/json" });
    expect(malformed.status).toBe(401);
    expect(malformed.headers["www-authenticate"]).toBe(CHALLENGE.replace("Bearer ", 'Bearer error="invalid_token", error_description="the access token is not valid here", '));
  });

  it("refuses a Host that is not PUBLIC_BASE_URL's, before the challenge", async () => {
    const port = await serve();
    for (const host of ["evil.example", "ogmcp.example.evil.example", "127.0.0.1", "not a host"]) {
      const res = await send(port, "POST", "/mcp", { host });
      expect(res.status).toBe(403);
      expect(res.headers["www-authenticate"]).toBeUndefined();
    }
    // Any port of the right host passes on to the challenge.
    expect((await send(port, "POST", "/mcp", { host: "ogmcp.example:443" })).status).toBe(401);
  });

  it("refuses an Origin not in MCP_ALLOWED_ORIGINS, matching exact origins only", async () => {
    const port = await serve();
    for (const origin of ["https://evil.example", "http://ogmcp.example", "http://claude.ai", "https://evil.claude.ai", "https://claude.ai.evil.example", "null"]) {
      expect((await send(port, "POST", "/mcp", { origin })).status).toBe(403);
    }
    // The default list: PUBLIC_BASE_URL and the target clients' web origins.
    for (const origin of [ISSUER, "https://claude.ai"]) {
      expect((await send(port, "POST", "/mcp", { origin })).status).toBe(401);
    }
  });
});

describe.skipIf(TEST_DATABASE_URL === undefined)("/mcp with a read token", () => {
  const name = `ogmcp_test_${randomBytes(6).toString("hex")}`;
  const CLIENT_ID = "test-client";
  const RESOURCE = `${ISSUER}/mcp`;
  let admin: Pool;
  let pool: Pool;
  let provider: Provider;

  beforeAll(async () => {
    admin = createPool({ url: TEST_DATABASE_URL ?? "", queryTimeoutMs: 10_000, max: 1 });
    await admin.query(`create database "${name}"`);
    const url = new URL(TEST_DATABASE_URL ?? "");
    url.pathname = `/${name}`;
    pool = createPool({ url: url.toString(), queryTimeoutMs: 10_000, max: 4 });
    await migrate(pool);
    await new PostgresAdapter(pool, "Client").upsert(CLIENT_ID, {
      client_id: CLIENT_ID,
      redirect_uris: ["https://agent.example/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    provider = createOidcProvider({ pool, issuer: ISSUER, keys: generateOidcKeys(), trustProxyHops: 1, log: () => {} });
  });

  afterAll(async () => {
    await pool?.end();
    try {
      await admin.query(`drop database if exists "${name}" with (force)`);
    } finally {
      await admin.end();
    }
  });

  /** The headers of a POST by an agent with a new user's `read` token, as the consent page leaves one (RED-303). */
  async function asAgent(): Promise<Record<string, string>> {
    const { rows } = await pool.query<{ uuid: string }>("insert into users default values returning uuid");
    const accountId = rows[0]?.uuid ?? "";
    const client = await provider.Client.find(CLIENT_ID);
    if (client === undefined) throw new Error("the test client is missing");
    const grant = new provider.Grant({ accountId, clientId: CLIENT_ID });
    grant.addResourceScope(RESOURCE, "read");
    const grantId = await grant.save();
    const token = await new provider.AccessToken({
      accountId,
      client,
      grantId,
      gty: "authorization_code",
      scope: "read",
      resourceServer: new provider.ResourceServer(RESOURCE, { scope: "read" }),
    }).save();
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  it("answers initialize and an empty tools/list, each on its own, with JSON and no session", async () => {
    const port = await serve(pool, provider);
    const agent = await asAgent();
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

    const init = await send(
      port,
      "POST",
      "/mcp",
      agent,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      }),
    );
    expect(init.status).toBe(200);
    expect(init.headers["content-type"]).toMatch(/^application\/json/);
    expect(init.headers["mcp-session-id"]).toBeUndefined();
    // No `listChanged`: the stateless server never sends it (D12).
    expect(JSON.parse(init.body)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "ogmcp", version } },
    });

    const list = await send(port, "POST", "/mcp", { ...agent, "mcp-protocol-version": "2025-11-25" }, '{"jsonrpc":"2.0","id":2,"method":"tools/list"}');
    expect(list.status).toBe(200);
    expect(JSON.parse(list.body)).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
  });

  it("answers GET and DELETE with 405, and a body too large or not JSON with a JSON-RPC error", async () => {
    const port = await serve(pool, provider);
    const agent = await asAgent();
    for (const method of ["GET", "DELETE"]) {
      const res = await send(port, method, "/mcp", { authorization: agent["authorization"] ?? "" });
      expect(res.status).toBe(405);
      expect(res.headers["allow"]).toBe("POST");
      expect(JSON.parse(res.body)).toEqual({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
    }
    const large = await send(port, "POST", "/mcp", agent, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(MAX_MCP_BODY_BYTES) } }));
    expect(large.status).toBe(413);
    expect(JSON.parse(large.body)).toEqual({ jsonrpc: "2.0", error: { code: -32600, message: "Request too large" }, id: null });
    const malformed = await send(port, "POST", "/mcp", agent, '{"jsonrpc":');
    expect(malformed.status).toBe(400);
    expect(JSON.parse(malformed.body)).toEqual({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  });
});
