import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "./app.js";
import { configureLogger } from "./log.js";
import { createOidcProvider } from "./oidc.js";
import { generateOidcKeys } from "./oidc-keys.js";
import { WebSessions } from "./web-sessions.js";

const ISSUER = "https://ogmcp.example";
const DAY_MS = 24 * 60 * 60 * 1000;
const USER_UUID = "0f1e2d3c-4b5a-4968-8778-a1b2c3d4e5f6";
/** A web session token: 43 base64url characters. */
const SESSION = `cookie-secret-${"x".repeat(29)}`;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// SESSION opens a web session of USER_UUID. Every other query fails with a SQLSTATE.
const failure = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
const pool = {
  query: (sql: string) =>
    sql.includes("from web_sessions")
      ? Promise.resolve({
          rows: [{ session_id: "1", session_uuid: USER_UUID, expires_at: new Date(Date.now() + DAY_MS), user_id: "1", user_uuid: USER_UUID }],
        })
      : Promise.reject(failure),
  connect: () => Promise.reject(failure),
} as unknown as Pool;

let server: Server | undefined;
let lines: string[] = [];

beforeEach(() => {
  lines = [];
  configureLogger({ level: "info", write: (line) => lines.push(line) });
});

afterEach(() => {
  server?.close();
  server = undefined;
});

function entries(): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function serve(trustProxyHops: number): Promise<string> {
  const sessions = new WebSessions({ pool, lifetimeMs: DAY_MS, renewWithinMs: 1, secure: false });
  const app = createApp({
    health: { checkDatabase: () => Promise.resolve() },
    auth: { pool, sessions, providers: { google: null, discord: null }, publicBaseUrl: ISSUER },
    oidc: createOidcProvider({ pool, issuer: ISSUER, keys: generateOidcKeys(), trustProxyHops }),
    trustProxyHops,
  });
  server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("log", () => {
  it("writes one JSON access line per request with its ID, and the health checks' at debug only", async () => {
    const base = await serve(1);
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    expect((await fetch(`${base}/health`)).status).toBe(200);

    // Behind a trusted proxy, the edge's well-formed ID names the request.
    const edge = await fetch(`${base}/api/v1/sign-in-providers`, { headers: { "x-railway-request-id": "Edge_id-1.2" } });
    expect(edge.headers.get("x-request-id")).toBe("Edge_id-1.2");
    const forged = await fetch(`${base}/api/v1/sign-in-providers`, { headers: { "x-railway-request-id": "not an id" } });
    expect(forged.headers.get("x-request-id")).toMatch(UUID);

    await vi.waitFor(() => expect(lines).toHaveLength(2));
    const line = {
      level: "info",
      time: expect.stringMatching(TIME),
      msg: "GET /api/v1/sign-in-providers 200",
      route: "/api/v1/sign-in-providers",
      method: "GET",
      status: 200,
      duration_ms: expect.any(Number),
    };
    expect(entries()).toEqual([
      { ...line, request_id: "Edge_id-1.2" },
      { ...line, request_id: forged.headers.get("x-request-id") },
    ]);

    configureLogger({ level: "debug" });
    await fetch(`${base}/health/live`);
    await vi.waitFor(() => expect(lines).toHaveLength(3));
    expect(entries()[2]).toMatchObject({ level: "debug", route: "/health/live", status: 200 });
  });

  it("gives a line deep in a request the request's ID, route pattern, and user uuid", async () => {
    const base = await serve(0);
    const device = "5b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
    // A client's X-Railway-Request-Id counts only behind a trusted proxy.
    const res = await fetch(`${base}/api/v1/devices/${device}`, {
      method: "DELETE",
      headers: { origin: ISSUER, cookie: `ogmcp_session=${SESSION}`, "x-railway-request-id": "client-picked" },
    });
    expect(res.status).toBe(500);
    const requestId = res.headers.get("x-request-id");
    expect(requestId).toMatch(UUID);

    await vi.waitFor(() => expect(lines).toHaveLength(2));
    const context = { time: expect.stringMatching(TIME), request_id: requestId, route: "/api/v1/devices/:uuid", user_uuid: USER_UUID };
    expect(entries()).toEqual([
      { level: "error", msg: "request failed: code=57014", ...context },
      { level: "info", msg: "DELETE /api/v1/devices/:uuid 500", ...context, method: "DELETE", status: 500, duration_ms: expect.any(Number) },
    ]);
    expect(lines.join("\n")).not.toContain(device);
  });

  it("writes no header, cookie, query string, body, code, or token of an OAuth request", async () => {
    const base = await serve(1);
    const secrets = {
      state: "state-secret",
      challenge: "challenge-secret-0123456789012345678901234567890123",
      code: "code-secret",
      verifier: "verifier-secret-01234567890123456789012345678901234",
      bearer: "bearer-secret",
      clientSecret: "client-secret",
    };
    const cookie = `ogmcp_session=${SESSION}`;

    const authorize = new URL("/oauth/authorize", base);
    authorize.search = new URLSearchParams({
      client_id: "agent",
      response_type: "code",
      redirect_uri: "https://agent.example/callback",
      scope: "read",
      state: secrets.state,
      code_challenge: secrets.challenge,
      code_challenge_method: "S256",
    }).toString();
    await (await fetch(authorize, { headers: { cookie, authorization: `Bearer ${secrets.bearer}` }, redirect: "manual" })).text();

    await (
      await fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { cookie, authorization: `Basic ${Buffer.from(`agent:${secrets.clientSecret}`).toString("base64")}` },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: secrets.code,
          code_verifier: secrets.verifier,
          redirect_uri: "https://agent.example/callback",
        }),
      })
    ).text();

    await (await fetch(`${base}/auth/google/callback?code=${secrets.code}&state=${secrets.state}`, { headers: { cookie } })).text();

    await vi.waitFor(() =>
      expect(entries().map((entry) => entry["route"])).toEqual(expect.arrayContaining(["/oauth/authorize", "/oauth/token", "/auth/google/callback"])),
    );
    // oidc-provider's hook writes its line in the request's context.
    expect(entries()).toContainEqual(expect.objectContaining({ level: "error", msg: "oauth server error: code=57014", route: "/oauth/authorize" }));
    const all = lines.join("\n");
    for (const secret of [...Object.values(secrets), SESSION, "agent.example"]) expect(all).not.toContain(secret);
  });
});
