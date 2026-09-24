import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { type CimdFetchLimits, FetchLimiter } from "./cimd.js";
import { createOidcProvider, type OidcOptions } from "./oidc.js";
import { generateOidcKeys } from "./oidc-keys.js";
import { WebSessions } from "./web-sessions.js";

const ISSUER = "https://ogmcp.example";
const REDIRECT_URI = "https://agent.example/callback";

/**
 * A database that stores no client, so an https `client_id` goes to its
 * metadata document, and that drops every write, such as the authorization
 * request's interaction.
 */
const noClients = { query: () => Promise.resolve({ rows: [], rowCount: 0 }) } as unknown as Pool;

type Fetch = NonNullable<OidcOptions["testOnlyFetch"]>;

/**
 * The test-only fetches (`OidcOptions.testOnlyFetch`). A `client_id` here is
 * `https://127.0.0.1:<port>/<path>`, and the document server listens on
 * plain http, so both fetch its `http:` twin. `guarded` passes on the agent
 * oidc-provider gives it, as its own fetch does, so the SSRF guard applies.
 * `unguarded` drops that agent to reach the local server.
 */
const guarded: Fetch = (url, init) => fetch(String(url).replace(/^https:/, "http:"), init);
const unguarded: Fetch = (url, init) => {
  const { dispatcher: _guard, ...rest } = (init ?? {}) as RequestInit & { dispatcher?: unknown };
  return guarded(url, rest);
};

const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server.listen(0, "127.0.0.1"));
  await once(server, "listening");
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The OAuth server with CIMD as configured, but for its fetch. Answers its base URL. */
async function serveOidc(testOnlyFetch: Fetch, cimdFetchLimits?: CimdFetchLimits): Promise<string> {
  const oidc = createOidcProvider({
    pool: noClients,
    issuer: ISSUER,
    keys: generateOidcKeys(),
    trustProxyHops: 0,
    log: () => {},
    cimdFetchLimits,
    testOnlyFetch,
  });
  const sessions = new WebSessions({ pool: noClients, lifetimeMs: 60_000, renewWithinMs: 60_000, secure: true });
  const app = createApp({
    health: { checkDatabase: () => Promise.resolve() },
    auth: { pool: noClients, sessions, providers: { google: null, discord: null }, publicBaseUrl: ISSUER },
    oidc,
  });
  return `http://${await listen(createServer(app))}`;
}

/** An authorization request with PKCE. A valid client gets 303 to its interaction; an invalid one, 400. */
async function authorize(base: string, clientId: string): Promise<{ status: number; location: string | null; body: string }> {
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid",
    code_challenge: createHash("sha256").update(randomBytes(32)).digest("base64url"),
    code_challenge_method: "S256",
  });
  const res = await fetch(`${base}/oauth/authorize?${query}`, { redirect: "manual" });
  return { status: res.status, location: res.headers.get("location"), body: await res.text() };
}

describe("client ID metadata documents", () => {
  const documents = new Map<string, Record<string, unknown>>();
  let host: string;

  /** Serves `document` at `path`, with the `client_id` of that URL unless it names another. */
  function publish(path: string, document: Record<string, unknown> = {}): string {
    const clientId = `https://${host}${path}`;
    documents.set(path, {
      client_id: clientId,
      client_name: "Test Agent",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      ...document,
    });
    return clientId;
  }

  beforeAll(async () => {
    host = await listen(
      createServer((req, res) => {
        const document = documents.get(req.url ?? "");
        if (document === undefined) return void res.writeHead(404).end();
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(document));
      }),
    );
  });

  afterAll(() => {
    for (const server of servers) server.close();
  });

  it("accepts a valid document", async () => {
    const base = await serveOidc(unguarded);
    const res = await authorize(base, publish("/valid.json"));
    expect(res.status).toBe(303);
    expect(res.location).toMatch(/^\/interaction\/[\w-]+$/);
  });

  it("refuses a document whose client_id is not its URL, or with an http redirect URI off loopback", async () => {
    const base = await serveOidc(unguarded);
    const mismatch = publish("/mismatch.json", { client_id: `https://${host}/other.json` });
    expect(await authorize(base, mismatch)).toMatchObject({ status: 400, body: expect.stringContaining("invalid_client_metadata") });
    const http = publish("/http.json", { redirect_uris: [REDIRECT_URI, "http://agent.example/callback"] });
    expect(await authorize(base, http)).toMatchObject({ status: 400, body: expect.stringContaining("client is not allowed") });
  });

  it("blocks a client_id at a private address with oidc-provider's SSRF guard", async () => {
    const clientId = publish("/private.json");
    const blocked = await authorize(await serveOidc(guarded), clientId);
    expect(blocked).toMatchObject({ status: 400, body: expect.stringContaining("client_id metadata document fetch failed") });
    // The same document, fetched without the guard, is valid.
    expect((await authorize(await serveOidc(unguarded), clientId)).status).toBe(303);
  });

  it("refuses a fetch over the per-host limit", async () => {
    const base = await serveOidc(unguarded, { perMinute: 10, perHostPerMinute: 1 });
    expect((await authorize(base, publish("/first.json"))).status).toBe(303);
    const second = await authorize(base, publish("/second.json"));
    expect(second).toMatchObject({ status: 400, body: expect.stringContaining("client_id metadata document fetch not allowed") });
  });
});

describe("FetchLimiter", () => {
  it("limits fetches per host and in all, per minute, and logs the first refusal only", () => {
    let now = 0;
    const lines: string[] = [];
    const limiter = new FetchLimiter({ perMinute: 3, perHostPerMinute: 2 }, (line) => lines.push(line), () => now);
    expect(["a", "a", "a", "b", "c"].map((host) => limiter.allow(host))).toEqual([true, true, false, true, false]);
    expect(lines).toHaveLength(1);
    now = 60_000;
    expect(limiter.allow("a")).toBe(true);
  });
});
