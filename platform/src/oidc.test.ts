import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { createPool } from "./db.js";
import { migrate } from "./migrations.js";
import { createOidcProvider } from "./oidc.js";
import { PostgresAdapter } from "./oidc-adapter.js";
import { generateOidcKeys } from "./oidc-keys.js";
import {
  DEFAULT_REGISTRATION,
  deleteUnusedClients,
  MAX_TRACKED_ADDRESSES,
  parseAddressRanges,
  RegistrationLimiter,
  type RegistrationSettings,
} from "./oidc-registration.js";
import { WebSessions } from "./web-sessions.js";

/** As in migrations.test.ts: a Postgres server whose user may create databases. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"]?.trim() || undefined;
if (TEST_DATABASE_URL === undefined) console.warn("TEST_DATABASE_URL is not set: the Postgres tests in oidc.test.ts are skipped");

const ISSUER = "https://ogmcp.example";
const DAY_MS = 24 * 60 * 60 * 1000;

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

// No request here sends a cookie or reaches a model, so nothing queries the database.
async function serve(trustProxyHops: number, registration: RegistrationSettings = DEFAULT_REGISTRATION): Promise<number> {
  const noDatabase = {} as Pool;
  const oidc = createOidcProvider({ pool: noDatabase, issuer: ISSUER, keys: generateOidcKeys(), trustProxyHops, registration, log: () => {} });
  const sessions = new WebSessions({ pool: noDatabase, lifetimeMs: DAY_MS, renewWithinMs: DAY_MS, secure: true });
  const app = createApp({
    health: { checkDatabase: () => Promise.resolve() },
    auth: { pool: noDatabase, sessions, providers: { google: null, discord: null }, publicBaseUrl: ISSUER },
    oidc,
    trustProxyHops,
  });
  server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

/** A registration request (RFC 7591) with a JSON body. */
async function register(base: string, body: unknown, path = "/oauth/register"): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** A GET as Railway's edge forwards it: the public Host, and the client's protocol in X-Forwarded-Proto. */
async function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        headers: { host: "ogmcp.example", "x-forwarded-proto": "https", accept: "application/json", ...headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("OAuth server", () => {
  it("serves discovery with PUBLIC_BASE_URL as the issuer and https endpoints behind one trusted proxy", async () => {
    const port = await serve(1);
    const discovery = await get(port, "/.well-known/openid-configuration");
    expect(discovery.status).toBe(200);
    const metadata = JSON.parse(discovery.body) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      jwks_uri: `${ISSUER}/oauth/jwks`,
      code_challenge_methods_supported: ["S256"],
    });
    expect(metadata["registration_endpoint"]).toBe(`${ISSUER}/oauth/register`);
    // Claude uses CIMD only with both of these advertised (§9).
    expect(metadata["client_id_metadata_document_supported"]).toBe(true);
    expect(metadata["token_endpoint_auth_methods_supported"]).toContain("none");
    // Off: a client's post_logout_redirect_uri would redirect without a click.
    expect(metadata["end_session_endpoint"]).toBeUndefined();
    // The bridge's device flow (§8.1).
    expect(metadata["device_authorization_endpoint"]).toBe(`${ISSUER}/oauth/device/auth`);

    // The public halves only.
    const jwks = JSON.parse((await get(port, "/oauth/jwks")).body) as { keys: Record<string, unknown>[] };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: "RSA", use: "sig" });
    expect(jwks.keys[0]).not.toHaveProperty("d");

    // Express keeps its own routes: sign-in is not oidc-provider's /auth/:uid.
    expect((await get(port, "/auth/google")).body).toBe("Sign-in with Google is not configured on this server.");
    expect((await get(port, "/health/live")).status).toBe(200);
  });

  it("builds endpoint URLs on the issuer's origin whatever X-Forwarded-Host and -Proto a client sends", async () => {
    const port = await serve(1);
    const forged = await get(port, "/.well-known/openid-configuration", {
      "x-forwarded-host": "evil.example, ogmcp.example",
      "x-forwarded-proto": "http, https",
    });
    const metadata = JSON.parse(forged.body) as Record<string, unknown>;
    expect(metadata["token_endpoint"]).toBe(`${ISSUER}/oauth/token`);
    expect(metadata["jwks_uri"]).toBe(`${ISSUER}/oauth/jwks`);
  });

  it("refuses to register a confidential client, a grant or response type other than the code flow's, and other metadata", async () => {
    const base = `http://127.0.0.1:${await serve(0, { ...DEFAULT_REGISTRATION, burst: 20 })}`;
    const client = { redirect_uris: ["https://agent.example/callback"], token_endpoint_auth_method: "none" };
    const refused: [Record<string, unknown>, string, RegExp][] = [
      [{ token_endpoint_auth_method: "client_secret_basic" }, "invalid_client_metadata", /token_endpoint_auth_method must be none/],
      [{ jwks_uri: "https://agent.example/jwks" }, "invalid_client_metadata", /jwks_uri is not accepted/],
      [{ grant_types: ["authorization_code", "client_credentials"] }, "invalid_client_metadata", /grant_types may only hold/],
      [{ grant_types: ["urn:ietf:params:oauth:grant-type:device_code"] }, "invalid_client_metadata", /grant_types may only hold/],
      [{ response_types: ["code id_token"] }, "invalid_client_metadata", /response_types may only hold code/],
      [{ redirect_uris: ["http://agent.example/callback"] }, "invalid_redirect_uri", /redirect_uris must be https/],
      [{ redirect_uris: ["com.agent.app:/callback"] }, "invalid_redirect_uri", /redirect_uris must be https/],
      [{ scope: "read ingest" }, "invalid_client_metadata", /scope may not hold ingest/],
      [{ sector_identifier_uri: "https://internal.example/sector" }, "invalid_client_metadata", /sector_identifier_uri is not accepted/],
    ];
    for (const [change, error, description] of refused) {
      const res = await register(base, { ...client, ...change });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; error_description: string };
      expect(body.error).toBe(error);
      expect(body.error_description).toMatch(description);
    }
  });

  it("limits registrations per client address, whatever the path's case or trailing slash", async () => {
    const base = `http://127.0.0.1:${await serve(0, { ...DEFAULT_REGISTRATION, burst: 2, ratePerHour: 1 })}`;
    // Refused registrations count too, and these never reach the database.
    expect((await register(base, {})).status).toBe(400);
    expect((await register(base, {})).status).toBe(400);
    const limited = await register(base, {}, "/oauth/REGISTER/");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(3000);
    expect(((await limited.json()) as { error: string }).error).toBe("too_many_requests");
    expect((await register(base, {})).status).toBe(429);
  });

  it("gives the trusted ranges one shared bucket, caps all registrations together, and keeps a bounded number of addresses", () => {
    let now = 0;
    const settings: RegistrationSettings = {
      ...DEFAULT_REGISTRATION,
      trustedRanges: parseAddressRanges("DCR_TRUSTED_RANGES", "160.79.104.0/21"),
      trustedBurst: 60,
      globalBurst: 70,
    };
    const limiter = new RegistrationLimiter(settings, () => now);
    // Claude's users through one egress address, and through its neighbours, share the trusted bucket.
    for (let i = 0; i < 60; i++) expect(limiter.take(i % 2 === 0 ? "160.79.104.7" : "::ffff:160.79.111.200")).toBe(0);
    expect(limiter.take("160.79.104.8")).toBeGreaterThan(0);
    // Other addresses keep their own buckets, until the global one is empty.
    for (let i = 0; i < 10; i++) expect(limiter.take(`198.51.100.${i}`)).toBe(0);
    expect(limiter.take("198.51.100.99")).toBeGreaterThan(0);

    const wide = new RegistrationLimiter({ ...DEFAULT_REGISTRATION, globalBurst: 1_000_000, globalRatePerHour: 1_000_000 }, () => now);
    for (let i = 0; i <= MAX_TRACKED_ADDRESSES; i++) wide.take(`10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`);
    expect(wide.tracked).toBe(MAX_TRACKED_ADDRESSES);
    now += 60 * 60 * 1000;
    wide.take("192.0.2.1");
    // The sweep drops every bucket that has refilled.
    expect(wide.tracked).toBe(1);
  });

  it("builds http endpoint URLs when no proxy is trusted, whatever X-Forwarded-Proto says", async () => {
    const port = await serve(0);
    const metadata = JSON.parse((await get(port, "/.well-known/openid-configuration")).body) as Record<string, unknown>;
    expect(metadata["issuer"]).toBe(ISSUER);
    expect(metadata["token_endpoint"]).toBe("http://ogmcp.example/oauth/token");
  });
});

/** A browser's cookie jar, enough for these flows. Paths are ignored, so every cookie goes with every request. */
class Browser {
  readonly cookies = new Map<string, string>();
  constructor(private readonly origin: string) {}

  get(path: string, accept = "text/html"): Promise<Response> {
    return this.send("GET", path, { accept });
  }

  /** A POST of the consent page, from the page's origin: `origin`. */
  post(path: string, origin: string): Promise<Response> {
    return this.send("POST", path, { accept: "application/json", origin });
  }

  private async send(method: string, path: string, headers: Record<string, string>): Promise<Response> {
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    const res = await fetch(path.startsWith("http") ? path : `${this.origin}${path}`, {
      method,
      redirect: "manual",
      headers: { ...headers, ...(cookie === "" ? {} : { cookie }) },
    });
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(";")[0] ?? "";
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      if (value === "" || /expires=Thu, 01 Jan 1970/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }
}

describe.skipIf(TEST_DATABASE_URL === undefined)("OAuth interactions against Postgres", () => {
  const name = `ogmcp_test_${randomBytes(6).toString("hex")}`;
  const issuer = "http://localhost:4790";
  const redirectUri = "https://agent.example/callback";
  /** An authorization request's client and redirect URI. */
  const agent = { clientId: "agent", redirectUri };
  const verifier = randomBytes(32).toString("base64url");
  let admin: Pool;
  let pool: Pool;
  let sessions: WebSessions;
  let oidc: ReturnType<typeof createOidcProvider>;
  let flowServer: Server | undefined;
  let base: string;

  beforeAll(async () => {
    admin = createPool({ url: TEST_DATABASE_URL ?? "", queryTimeoutMs: 10_000, max: 1 });
    await admin.query(`create database "${name}"`);
    const url = new URL(TEST_DATABASE_URL ?? "");
    url.pathname = `/${name}`;
    pool = createPool({ url: url.toString(), queryTimeoutMs: 10_000, max: 4 });
    await migrate(pool);
    // A client stored as dynamic registration will store one (RED-304).
    await new PostgresAdapter(pool, "Client").upsert("agent", {
      client_id: "agent",
      client_name: "Test Agent",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    });
    sessions = new WebSessions({ pool, lifetimeMs: 30 * DAY_MS, renewWithinMs: 15 * DAY_MS, secure: false });
    oidc = createOidcProvider({ pool, issuer, keys: generateOidcKeys(), trustProxyHops: 0, log: () => {} });
    const app = createApp({
      health: { checkDatabase: () => Promise.resolve() },
      auth: { pool, sessions, providers: { google: null, discord: null }, publicBaseUrl: issuer, log: () => {} },
      oidc,
    });
    flowServer = createServer(app).listen(0, "127.0.0.1");
    await once(flowServer, "listening");
    base = `http://127.0.0.1:${(flowServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    flowServer?.close();
    await pool?.end();
    try {
      await admin.query(`drop database if exists "${name}" with (force)`);
    } finally {
      await admin.end();
    }
  });

  /** Signs the browser in as a new user, or as the user `userId`. Answers the user's id. */
  async function signIn(browser: Browser, userId?: string): Promise<string> {
    let id = userId;
    if (id === undefined) {
      const { rows } = await pool.query<{ id: string }>("insert into users default values returning id");
      id = rows[0]?.id ?? "";
    }
    browser.cookies.set(sessions.cookieName, (await sessions.create(id)).token);
    return id;
  }

  /** Starts an authorization request and answers the `/interaction/:uid` path it sends the browser to. */
  async function authorize(browser: Browser, extra = "", request = agent): Promise<string> {
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const query = new URLSearchParams({
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
      response_type: "code",
      // An agent's scope. The request gets the MCP resource (oidc-tokens.ts).
      scope: "openid read",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const res = await browser.get(`/oauth/authorize?${query}${extra}`);
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location).toMatch(/^\/interaction\/[\w-]+$/);
    return location;
  }

  /** Starts an authorization request in a signed-in browser and follows it to the consent page. Answers the interaction's path. */
  async function reachConsent(browser: Browser, request = agent): Promise<string> {
    const resume = (await browser.get(await authorize(browser, "", request))).headers.get("location") ?? "";
    const path = (await browser.get(resume)).headers.get("location") ?? "";
    const page = await browser.get(path);
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe(`/consent/${path.split("/")[2]}`);
    return path;
  }

  /** Follows the `location` an answer on the consent page gives, back through oidc-provider to the client. */
  async function answer(browser: Browser, path: string, choice: "approve" | "deny", request = agent): Promise<URL> {
    const res = await browser.post(`${path}/${choice}`, issuer);
    expect(res.status).toBe(200);
    const { location } = (await res.json()) as { location: string };
    const callback = await browser.get(location);
    expect(callback.status).toBe(303);
    const url = new URL(callback.headers.get("location") ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(request.redirectUri);
    return url;
  }

  async function prompt(interactionPath: string): Promise<{ name: string; reasons: string[] }> {
    const { rows } = await pool.query<{ prompt: { name: string; reasons: string[] } }>(
      "select payload->'prompt' as prompt from oidc_models where model = 'Interaction' and oidc_id = $1",
      [interactionPath.split("/")[2]],
    );
    return rows[0]?.prompt ?? { name: "", reasons: [] };
  }

  it("asks for a new login when the web session changes from one user to another", async () => {
    const browser = new Browser(base);
    await signIn(browser);
    const first = await authorize(browser);
    const resume = (await browser.get(first)).headers.get("location") ?? "";
    expect(resume).toContain("/oauth/authorize/");
    // Signed in as the first user, the request reaches consent.
    const consent = (await browser.get(resume)).headers.get("location") ?? "";
    expect(await prompt(consent)).toMatchObject({ name: "consent" });

    await signIn(browser);
    const second = await authorize(browser);
    expect(await prompt(second)).toMatchObject({ name: "login", reasons: ["web_session"] });
    expect((await browser.get(`${second}/details`, "application/json")).status).toBe(403);
  });

  it("answers 400 to a browser that is not the one the interaction started in", async () => {
    const owner = new Browser(base);
    const path = await authorize(owner);
    const other = new Browser(base);
    await signIn(other);
    expect((await other.get(path)).status).toBe(400);
    // With an interaction cookie of its own, for another interaction.
    await authorize(other);
    expect((await other.get(path)).status).toBe(400);
    expect((await other.get(`${path}/details`, "application/json")).status).toBe(400);
    // The browser it started in is sent to sign in.
    expect((await owner.get(path)).headers.get("location")).toBe(`/signin?return_to=${encodeURIComponent(path)}`);
  });

  it("sends a signed-in user through sign-in again for prompt=login, and goes on after a fresh sign-in", async () => {
    const browser = new Browser(base);
    await signIn(browser);
    await pool.query("update web_sessions set created_at = now() - interval '1 hour'");
    const path = await authorize(browser, "&prompt=login");
    expect((await prompt(path)).reasons).toContain("login_prompt");
    const again = await browser.get(path);
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe(`/signin?return_to=${encodeURIComponent(path)}`);

    await signIn(browser);
    expect((await browser.get(path)).headers.get("location")).toContain("/oauth/authorize/");
  });

  it("approves at the consent page: the grant is saved and the client exchanges its code for a token", async () => {
    const browser = new Browser(base);
    await signIn(browser);
    const path = await reachConsent(browser);
    const details = await browser.get(`${path}/details`, "application/json");
    expect(await details.json()).toMatchObject({
      client_name: "Test Agent",
      client_host: null,
      redirect_host: "agent.example",
      redirect_loopback: false,
      scopes: ["openid", "read"],
    });
    // Another site cannot answer for the user.
    expect((await browser.post(`${path}/approve`, "https://evil.example")).status).toBe(403);

    const callback = await answer(browser, path, "approve");
    const code = callback.searchParams.get("code") ?? "";
    expect(code).not.toBe("");
    const token = await fetch(`${base}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: "agent", code_verifier: verifier }),
    });
    expect(token.status).toBe(200);
    // A token for the MCP resource carries only its scope.
    expect(await token.json()).toMatchObject({ access_token: expect.any(String), token_type: "Bearer", scope: "read" });
  });

  it("signs in a client with Claude Code's metadata at a loopback redirect URI on a port it did not register", async () => {
    // Stored, it is built without a ctx, as a CIMD client is (cimd.test.ts).
    await new PostgresAdapter(pool, "Client").upsert("claude-code", {
      client_id: "claude-code",
      client_name: "Claude Code",
      client_uri: "https://claude.ai",
      redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    const request = { clientId: "claude-code", redirectUri: "http://localhost:53682/callback" };
    const browser = new Browser(base);
    await signIn(browser);
    const path = await reachConsent(browser, request);
    const details = await browser.get(`${path}/details`, "application/json");
    expect(await details.json()).toMatchObject({ client_name: "Claude Code", redirect_host: "localhost:53682", redirect_loopback: true });

    const code = (await answer(browser, path, "approve", request)).searchParams.get("code") ?? "";
    const token = await fetch(`${base}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: request.redirectUri, client_id: "claude-code", code_verifier: verifier }),
    });
    expect(token.status).toBe(200);
  });

  it("denies at the consent page: the client gets access_denied", async () => {
    const browser = new Browser(base);
    await signIn(browser);
    const callback = await answer(browser, await reachConsent(browser), "deny");
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.has("code")).toBe(false);
  });

  it("takes no answer from another browser, even one signed in as the same user", async () => {
    const owner = new Browser(base);
    const userId = await signIn(owner);
    const path = await reachConsent(owner);
    const other = new Browser(base);
    await signIn(other, userId);
    expect((await other.post(`${path}/approve`, issuer)).status).toBe(400);
    expect((await other.post(`${path}/deny`, issuer)).status).toBe(400);
    expect((await other.get(`${path}/details`, "application/json")).status).toBe(400);
  });

  /**
   * A client as Claude registers it, but without `token_endpoint_auth_method`,
   * with the MCP scope, and with metadata that is dropped: logout redirects,
   * and an HMAC algorithm that oidc-provider makes a secret for.
   */
  async function registerAgent(): Promise<{ client_id: string } & Record<string, unknown>> {
    const res = await register(base, {
      client_name: "Agent",
      redirect_uris: [redirectUri, "http://127.0.0.1:33418/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "read",
      post_logout_redirect_uris: ["https://agent.example/signed-out"],
      request_object_signing_alg: "HS256",
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { client_id: string } & Record<string, unknown>;
  }

  it("registers a public client that can start an authorization request", async () => {
    const client = await registerAgent();
    expect(client).toMatchObject({ token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] });
    expect(client).not.toHaveProperty("client_secret");
    expect(client).not.toHaveProperty("registration_access_token");
    expect(client).not.toHaveProperty("scope");
    expect(client).not.toHaveProperty("post_logout_redirect_uris");
    // Its loopback redirect URI makes it native: that URI matches on any port.
    expect(client).toMatchObject({ application_type: "native" });
    const stored = await pool.query("select 1 from oidc_models where model = 'Client' and oidc_id = $1 and not payload ? 'client_secret'", [client.client_id]);
    expect(stored.rowCount).toBe(1);

    const challenge = createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url");
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const res = await new Browser(base).get(`/oauth/authorize?${query}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^\/interaction\//);
    query.set("redirect_uri", "http://127.0.0.1:53682/callback");
    expect((await new Browser(base).get(`/oauth/authorize?${query}`)).status).toBe(303);
  });

  it("records a client's last token, deletes clients unused past the threshold, and then answers invalid_client", async () => {
    const unused = await registerAgent();
    const used = await registerAgent();
    const registeredLongAgo = "jsonb_set(payload, '{client_id_issued_at}', to_jsonb(extract(epoch from now() - interval '91 days')::bigint))";
    await pool.query(`update oidc_models set payload = ${registeredLongAgo} where model = 'Client' and oidc_id = any($1)`, [
      [unused.client_id, used.client_id],
    ]);

    // A token for `used`: a refresh token of a grant, as the code flow leaves them.
    const { rows } = await pool.query<{ uuid: string }>("insert into users default values returning uuid");
    const accountId = rows[0]?.uuid ?? "";
    const grant = new oidc.Grant({ accountId, clientId: used.client_id });
    grant.addOIDCScope("openid offline_access");
    const grantId = await grant.save();
    const client = await oidc.Client.find(used.client_id);
    if (client === undefined) throw new Error("the registered client is not stored");
    const refreshToken = await new oidc.RefreshToken({ accountId, client, grantId, scope: "openid offline_access", gty: "authorization_code" }).save();
    const refreshed = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: used.client_id }),
    });
    expect(refreshed.status).toBe(200);
    const lastUsed = await pool.query("select last_used_at from oidc_models where model = 'Client' and oidc_id = $1 and last_used_at > now() - interval '1 minute'", [
      used.client_id,
    ]);
    expect(lastUsed.rowCount).toBe(1);

    const unusedGrant = new oidc.Grant({ accountId, clientId: unused.client_id });
    unusedGrant.addOIDCScope("openid");
    const unusedGrantId = await unusedGrant.save();

    expect(await deleteUnusedClients(pool, 90)).toBe(1);
    // With its grants and tokens; the used client keeps its own.
    expect(await oidc.Grant.find(unusedGrantId)).toBeUndefined();
    expect(await oidc.Grant.find(grantId)).toBeDefined();
    const left = await pool.query<{ oidc_id: string }>("select oidc_id from oidc_models where model = 'Client'");
    expect(left.rows.map((row) => row.oidc_id)).toEqual(expect.arrayContaining(["agent", used.client_id]));
    expect(left.rows.map((row) => row.oidc_id)).not.toContain(unused.client_id);

    const res = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "any", client_id: unused.client_id }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_client");
  });
});
