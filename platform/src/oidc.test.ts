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
async function serve(trustProxyHops: number): Promise<number> {
  const noDatabase = {} as Pool;
  const oidc = createOidcProvider({ pool: noDatabase, issuer: ISSUER, keys: generateOidcKeys(), trustProxyHops, log: () => {} });
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
    // Off until their own issues.
    expect(metadata["registration_endpoint"]).toBeUndefined();
    expect(metadata["device_authorization_endpoint"]).toBeUndefined();
    expect(metadata["client_id_metadata_document_supported"]).toBeUndefined();

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
  const verifier = randomBytes(32).toString("base64url");
  let admin: Pool;
  let pool: Pool;
  let sessions: WebSessions;
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
    const oidc = createOidcProvider({ pool, issuer, keys: generateOidcKeys(), trustProxyHops: 0, log: () => {} });
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
  async function authorize(browser: Browser, extra = ""): Promise<string> {
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const query = new URLSearchParams({
      client_id: "agent",
      redirect_uri: redirectUri,
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
  async function reachConsent(browser: Browser): Promise<string> {
    const resume = (await browser.get(await authorize(browser))).headers.get("location") ?? "";
    const path = (await browser.get(resume)).headers.get("location") ?? "";
    const page = await browser.get(path);
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe(`/consent/${path.split("/")[2]}`);
    return path;
  }

  /** Follows the `location` an answer on the consent page gives, back through oidc-provider to the client. */
  async function answer(browser: Browser, path: string, choice: "approve" | "deny"): Promise<URL> {
    const res = await browser.post(`${path}/${choice}`, issuer);
    expect(res.status).toBe(200);
    const { location } = (await res.json()) as { location: string };
    const callback = await browser.get(location);
    expect(callback.status).toBe(303);
    const url = new URL(callback.headers.get("location") ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(redirectUri);
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
    expect(await details.json()).toMatchObject({ client_name: "Test Agent", redirect_host: "agent.example", scopes: ["openid", "read"] });
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
});
