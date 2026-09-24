import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { addressKey, type CimdFetchLimits, DEFAULT_CIMD_FETCH_LIMITS, FetchLimiter } from "./cimd.js";
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

const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server.listen(0, "127.0.0.1"));
  await once(server, "listening");
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The OAuth server with CIMD as configured, but for its fetch (`OidcOptions.testOnlyFetch`). Answers its base URL. */
async function serveOidc(testOnlyFetch: Fetch, cimdFetchLimits?: CimdFetchLimits): Promise<string> {
  // One trusted proxy, so a test can set the client address in X-Forwarded-For.
  const trustProxyHops = 1;
  const oidc = createOidcProvider({
    pool: noClients,
    issuer: ISSUER,
    keys: generateOidcKeys(),
    trustProxyHops,
    log: () => {},
    cimdFetchLimits,
    testOnlyFetch,
  });
  const sessions = new WebSessions({ pool: noClients, lifetimeMs: 60_000, renewWithinMs: 60_000, secure: true });
  const app = createApp({
    health: { checkDatabase: () => Promise.resolve() },
    auth: { pool: noClients, sessions, providers: { google: null, discord: null }, publicBaseUrl: ISSUER },
    oidc,
    trustProxyHops,
  });
  return `http://${await listen(createServer(app))}`;
}

interface Answer {
  status: number;
  location: string | null;
  body: string;
}

/** An authorization request with PKCE, from `address`. A valid client gets 303 to its interaction; an invalid one, 400. */
async function authorize(base: string, clientId: string, address = "192.0.2.1"): Promise<Answer> {
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid",
    code_challenge: createHash("sha256").update(randomBytes(32)).digest("base64url"),
    code_challenge_method: "S256",
  });
  const res = await fetch(`${base}/oauth/authorize?${query}`, { redirect: "manual", headers: { "x-forwarded-for": address } });
  return { status: res.status, location: res.headers.get("location"), body: await res.text() };
}

describe("client ID metadata documents", () => {
  const documents = new Map<string, Record<string, unknown>>();
  /** Requests the document server got, by path. */
  const hits = new Map<string, number>();
  let host: string;

  /**
   * The test-only fetches. Each one fetches any URL from the document
   * server, over http. `guarded` passes on the agent oidc-provider gives it,
   * as the global fetch does, so the SSRF guard applies; `unguarded` drops
   * that agent to reach the local server.
   */
  const local =
    (guard: boolean): Fetch =>
    (input, init) => {
      const { dispatcher, ...rest } = (init ?? {}) as RequestInit & { dispatcher?: unknown };
      const url = new URL(input instanceof Request ? input.url : input);
      return fetch(`http://${host}${url.pathname}`, guard ? { ...rest, dispatcher } : rest);
    };
  const guarded = local(true);
  const unguarded = local(false);

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
        const path = req.url ?? "";
        hits.set(path, (hits.get(path) ?? 0) + 1);
        const document = documents.get(path);
        if (document === undefined) return void res.writeHead(404).end();
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(document));
      }),
    );
  });

  beforeEach(() => hits.clear());

  afterAll(() => {
    for (const server of servers) server.close();
  });

  it("accepts a valid document", async () => {
    const base = await serveOidc(unguarded);
    const res = await authorize(base, publish("/valid.json"));
    expect(res.status).toBe(303);
    expect(res.location).toMatch(/^\/interaction\/[\w-]+$/);
  });

  it("refuses a document with another client_id, an http redirect URI off loopback, or a sector_identifier_uri", async () => {
    const base = await serveOidc(unguarded);
    const mismatch = publish("/mismatch.json", { client_id: `https://${host}/other.json` });
    expect(await authorize(base, mismatch)).toMatchObject({ status: 400, body: expect.stringContaining("invalid_client_metadata") });
    const http = publish("/http.json", { redirect_uris: [REDIRECT_URI, "http://agent.example/callback"] });
    expect(await authorize(base, http)).toMatchObject({ status: 400, body: expect.stringContaining("client is not allowed") });
    const sector = publish("/sector.json", { sector_identifier_uri: `https://${host}/sector-uris.json` });
    expect(await authorize(base, sector)).toMatchObject({ status: 400, body: expect.stringContaining("client is not allowed") });
    expect(hits.get("/sector-uris.json")).toBeUndefined();
  });

  it("blocks a client_id at a private address with oidc-provider's SSRF guard", async () => {
    const clientId = publish("/private.json");
    const blocked = await authorize(await serveOidc(guarded), clientId);
    expect(blocked).toMatchObject({ status: 400, body: expect.stringContaining("client_id metadata document fetch failed") });
    // The same document, fetched without the guard, is valid.
    expect((await authorize(await serveOidc(unguarded), clientId)).status).toBe(303);
  });

  it("refuses a fetch over the per-host limit", async () => {
    const base = await serveOidc(unguarded, { ...DEFAULT_CIMD_FETCH_LIMITS, perHostPerMinute: 1 });
    expect((await authorize(base, publish("/first.json"))).status).toBe(303);
    const second = await authorize(base, publish("/second.json"));
    expect(second).toMatchObject({ status: 400, body: expect.stringContaining("client_id metadata document fetch not allowed") });
  });

  const failed = { status: 400, body: expect.stringContaining("client_id metadata document fetch failed") };
  const refused = { status: 400, body: expect.stringContaining("client_id metadata document fetch not allowed") };

  /** Serves a JWKS at `path`, and a document at `document` for a client that signs its token requests with it. */
  function publishSigned(document: string, path: string, overrides: Record<string, unknown> = {}): string {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    documents.set(path, { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] });
    return publish(document, {
      token_endpoint_auth_method: "private_key_jwt",
      token_endpoint_auth_signing_alg: "RS256",
      jwks_uri: `https://${host}${path}`,
      ...overrides,
    });
  }

  /** A token request from `address`, whose client assertion has good claims and a signature of random bytes. Answers the status. */
  async function tokenRequest(base: string, clientId: string, address = "192.0.2.1"): Promise<number> {
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const exp = Math.floor(Date.now() / 1000) + 60;
    const claims = { iss: clientId, sub: clientId, aud: ISSUER, jti: randomBytes(8).toString("hex"), exp };
    const assertion = `${part({ alg: "RS256", kid: "k1" })}.${part(claims)}.${randomBytes(256).toString("base64url")}`;
    const res = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": address },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "not-a-code",
        redirect_uri: REDIRECT_URI,
        code_verifier: randomBytes(32).toString("base64url"),
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
      }),
    });
    return res.status;
  }

  it("fetches a client's jwks_uri once for a flood of token requests with bad client assertions", async () => {
    const base = await serveOidc(unguarded);
    const clientId = publishSigned("/signed.json", "/jwks.json");
    expect(await tokenRequest(base, clientId)).toBe(401);
    expect(await Promise.all(Array.from({ length: 25 }, () => tokenRequest(base, clientId)))).toEqual(Array(25).fill(401));
    expect(hits.get("/signed.json")).toBe(1);
    expect(hits.get("/jwks.json")).toBe(1);
  });

  it("limits the fetches one client address causes, token requests included, with IPv6 by /64", async () => {
    const base = await serveOidc(unguarded, { ...DEFAULT_CIMD_FETCH_LIMITS, perIpPerMinute: 1 });
    const clientId = publishSigned("/address.json", "/address-jwks.json");
    // The document fetch uses the /64's one fetch.
    expect((await authorize(base, clientId, "2001:db8:1:1::1")).status).toBe(303);
    expect(await authorize(base, publish("/address-2.json"), "2001:db8:1:1::2")).toMatchObject(refused);
    expect(await tokenRequest(base, clientId, "2001:db8:1:1::3")).toBe(401);
    expect(hits.get("/address-jwks.json")).toBeUndefined();
    // Another /64 may cause one.
    expect(await tokenRequest(base, clientId, "2001:db8:1:2::1")).toBe(401);
    expect(hits.get("/address-jwks.json")).toBe(1);
  });

  it("keeps a trusted client working after a flood of made-up client_ids on its host and on others", async () => {
    const trusted = publish("/trusted.json");
    const base = await serveOidc(unguarded, { perMinute: 4, perHostPerMinute: 2, perIpPerMinute: 100, trustedClientIds: [trusted] });
    // oidc-provider looks a client up twice for a failed authorization request: two fetches each.
    expect(await authorize(base, `https://${host}/made-up-1.json`, "198.51.100.1")).toMatchObject(failed);
    expect(await authorize(base, `https://${host}/made-up-2.json`, "198.51.100.2")).toMatchObject(refused);
    expect(await authorize(base, "https://a1.invalid/x", "198.51.100.3")).toMatchObject(failed);
    expect(await authorize(base, "https://a2.invalid/x", "198.51.100.3")).toMatchObject(refused);
    // The host and the total are used up; the trusted client_id is fetched all the same.
    expect((await authorize(base, trusted, "198.51.100.4")).status).toBe(303);
  });

  it("keeps a trusted client working after a flood of token requests from clients whose jwks_uri is on its host", async () => {
    const trusted = publish("/trusted-2.json");
    const base = await serveOidc(unguarded, { perMinute: 100, perHostPerMinute: 2, perIpPerMinute: 100, trustedClientIds: [trusted] });
    for (const n of [1, 2, 3]) {
      // A client on another host, whose jwks_uri is on the trusted client's host, is refused (400) before any JWKS fetch.
      const clientId = `https://attacker-${n}.test/client.json`;
      publishSigned(`/attacker-${n}.json`, `/attacker-jwks-${n}.json`, { client_id: clientId });
      documents.set("/client.json", documents.get(`/attacker-${n}.json`) ?? {});
      expect(await tokenRequest(base, clientId)).toBe(400);
      expect(hits.get(`/attacker-jwks-${n}.json`)).toBeUndefined();
    }
    expect((await authorize(base, trusted)).status).toBe(303);
  });
});

describe("FetchLimiter", () => {
  it("counts in one-minute windows, and logs the first refusal of each only", () => {
    let now = 0;
    const lines: string[] = [];
    const limits = { perMinute: 1, perHostPerMinute: 5, perIpPerMinute: 5, trustedClientIds: [] };
    const limiter = new FetchLimiter(limits, (line) => lines.push(line), () => now);
    const take = (host: string) => limiter.take(`https://${host}/c.json`, "document", undefined);
    expect(["a", "b", "c"].map(take)).toEqual([true, false, false]);
    expect(lines).toHaveLength(1);
    now = 60_000;
    expect(take("b")).toBe(true);
  });

  it("keys an IPv6 address by its /64", () => {
    expect(addressKey("2001:db8:1:1::1")).toBe(addressKey("2001:DB8:1:1:ffff:ffff:ffff:ffff"));
    expect(addressKey("2001:db8:1:1::1")).not.toBe(addressKey("2001:db8:1:2::1"));
    expect(addressKey("::ffff:192.0.2.1")).toBe("192.0.2.1");
  });
});
