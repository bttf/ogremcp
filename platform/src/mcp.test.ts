import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { createOidcProvider } from "./oidc.js";
import { generateOidcKeys } from "./oidc-keys.js";
import { WebSessions } from "./web-sessions.js";

const ISSUER = "https://ogmcp.example";
const DAY_MS = 24 * 60 * 60 * 1000;

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

// No request here sends a cookie or reaches a model, so nothing queries the database.
async function serve(): Promise<number> {
  const noDatabase = {} as Pool;
  const oidc = createOidcProvider({ pool: noDatabase, issuer: ISSUER, keys: generateOidcKeys(), trustProxyHops: 1, log: () => {} });
  const sessions = new WebSessions({ pool: noDatabase, lifetimeMs: DAY_MS, renewWithinMs: DAY_MS, secure: true });
  const app = createApp({
    health: { checkDatabase: () => Promise.resolve() },
    auth: { pool: noDatabase, sessions, providers: { google: null, discord: null }, publicBaseUrl: ISSUER },
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

/** A request as Railway's edge forwards it: the public Host, and https in X-Forwarded-Proto. */
async function send(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<Answer> {
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
    req.end(method === "POST" ? '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' : undefined);
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
  it("answers a request without a bearer token with 401 and the challenge, and one with a token with 501", async () => {
    const port = await serve();
    for (const method of ["POST", "GET"]) {
      const res = await send(port, method, "/mcp", { "content-type": "application/json" });
      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toBe(CHALLENGE);
    }
    // Not a bearer token.
    const basic = await send(port, "POST", "/mcp", { authorization: "Basic dXNlcjpwYXNz" });
    expect(basic.status).toBe(401);
    expect(basic.headers["www-authenticate"]).toBe(CHALLENGE);
    // Until RED-302 verifies the token and RED-325 serves MCP.
    const bearer = await send(port, "POST", "/mcp", { authorization: "Bearer some-token", "content-type": "application/json" });
    expect(bearer.status).toBe(501);
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

  it("refuses an Origin that is not PUBLIC_BASE_URL's", async () => {
    const port = await serve();
    for (const origin of ["https://evil.example", "http://ogmcp.example", "null"]) {
      expect((await send(port, "POST", "/mcp", { origin })).status).toBe(403);
    }
    expect((await send(port, "POST", "/mcp", { origin: ISSUER })).status).toBe(401);
  });
});
