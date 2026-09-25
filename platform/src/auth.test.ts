import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import type { AuthOptions } from "./auth.js";
import { createPool } from "./db.js";
import { migrate } from "./migrations.js";
import { callbackUrl, discordProvider, googleProvider, type SignInProviders } from "./sign-in-providers.js";
import { generateSessionToken, hashSessionToken, WebSessions } from "./web-sessions.js";

/** As in migrations.test.ts: a Postgres server whose user may create databases. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"]?.trim() || undefined;
if (TEST_DATABASE_URL === undefined) console.warn("TEST_DATABASE_URL is not set: the Postgres tests in auth.test.ts are skipped");

const BASE = "http://localhost:4790";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Both providers report this address, to show that accounts are never matched by it. */
const SHARED_EMAIL = "player@example.com";

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

async function serve(auth: AuthOptions): Promise<string> {
  server = createServer(createApp({ health: { checkDatabase: () => Promise.resolve() }, auth })).listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A browser's cookie jar, enough for these flows. Paths are ignored. */
class Browser {
  private readonly cookies = new Map<string, string>();
  constructor(private readonly origin: string) {}

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    const res = await fetch(`${this.origin}${path}`, {
      ...init,
      redirect: "manual",
      headers: { ...(cookie === "" ? {} : { cookie }), ...(init.headers as Record<string, string> | undefined) },
    });
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (value === "" || /expires=Thu, 01 Jan 1970/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  cookie(name: string): string | undefined {
    return this.cookies.get(name);
  }
}

/** An ID token as Google's token endpoint returns it. The signature is not checked, so none is made. */
function idToken(claims: Record<string, unknown>): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}.${Buffer.from("signature").toString("base64url")}`;
}

/**
 * Google and Discord as the injected `fetch` sees them, so that openid-client
 * runs its own checks. A code is the account id the provider reports. Google's
 * ID token and Discord's profile both carry `SHARED_EMAIL`. Token requests
 * are kept for the test to read.
 */
function fakeProviders(): { providers: SignInProviders; tokenRequests: URLSearchParams[] } {
  const tokenRequests: URLSearchParams[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const form = new URLSearchParams((init?.body as string | URLSearchParams | undefined) ?? "");
    const now = Math.floor(Date.now() / 1000);
    switch (url) {
      case "https://accounts.google.com/.well-known/openid-configuration":
        return Response.json({
          issuer: "https://accounts.google.com",
          authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          token_endpoint: "https://oauth2.googleapis.com/token",
          jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["plain", "S256"],
        });
      case "https://oauth2.googleapis.com/token":
        tokenRequests.push(form);
        if (form.get("code") === "rejected") {
          return Response.json({ error: "invalid_grant\nforged log line", error_description: "detail never logged" }, { status: 400 });
        }
        if (form.get("code") === "expired") return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({
          access_token: "google-access",
          token_type: "Bearer",
          expires_in: 3600,
          id_token: idToken({ iss: "https://accounts.google.com", aud: "google-client", sub: form.get("code"), iat: now, exp: now + 3600, email: SHARED_EMAIL }),
        });
      case "https://discord.com/api/oauth2/token":
        tokenRequests.push(form);
        return Response.json({ access_token: `discord-access-${form.get("code")}`, token_type: "Bearer", expires_in: 604800, scope: "identify" });
      case "https://discord.com/api/users/@me": {
        const token = new Headers(init?.headers).get("authorization") ?? "";
        return Response.json({ id: token.replace("Bearer discord-access-", ""), email: SHARED_EMAIL });
      }
      default:
        return new Response("not found", { status: 404 });
    }
  }) as typeof fetch;
  const secret = "unused";
  return {
    providers: {
      google: googleProvider({ clientId: "google-client", clientSecret: secret, redirectUri: callbackUrl(BASE, "google"), fetch: fake }),
      discord: discordProvider({ clientId: "discord-client", clientSecret: secret, redirectUri: callbackUrl(BASE, "discord"), fetch: fake }),
    },
    tokenRequests,
  };
}

describe("session tokens", () => {
  it("hashes a token to the SHA-256 of its characters, and makes a new token each time", () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashSessionToken(token).equals(createHash("sha256").update(token).digest())).toBe(true);
    expect(generateSessionToken()).not.toBe(token);
  });
});

// No web session cookie is sent in these, so nothing queries the database.
describe("sign-in without the database", () => {
  const noDatabase = {} as Pool;

  it("answers 503 with a plain message for a provider without credentials, and the service still serves", async () => {
    const sessions = new WebSessions({ pool: noDatabase, lifetimeMs: DAY_MS, renewWithinMs: DAY_MS, secure: false });
    const base = await serve({ pool: noDatabase, sessions, providers: { google: null, discord: null }, publicBaseUrl: BASE });
    for (const path of ["/auth/google", "/auth/discord/callback?code=x&state=y"]) {
      const res = await fetch(`${base}${path}`, { redirect: "manual" });
      expect(res.status).toBe(503);
      expect(await res.text()).toMatch(/^Sign-in with (Google|Discord) is not configured on this server\.$/);
    }
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
  });

  it("sets a __Host- sign-in cookie for each provider over https", async () => {
    const sessions = new WebSessions({ pool: noDatabase, lifetimeMs: DAY_MS, renewWithinMs: DAY_MS, secure: true });
    const base = await serve({ pool: noDatabase, sessions, providers: fakeProviders().providers, publicBaseUrl: "https://ogremcp.example" });
    for (const provider of ["google", "discord"]) {
      const res = await fetch(`${base}/auth/${provider}`, { redirect: "manual" });
      expect(res.headers.getSetCookie()).toEqual([
        expect.stringMatching(new RegExp(`^__Host-ogremcp_signin_${provider}=[^;]+; Max-Age=600; Path=/; Expires=[^;]+; HttpOnly; Secure; SameSite=Lax$`)),
      ]);
    }
  });

  it("logs a provider's error code only when it is a plain code, and never its description", async () => {
    const lines: string[] = [];
    const sessions = new WebSessions({ pool: noDatabase, lifetimeMs: DAY_MS, renewWithinMs: DAY_MS, secure: false });
    const base = await serve({ pool: noDatabase, sessions, providers: fakeProviders().providers, publicBaseUrl: BASE, log: (line) => lines.push(line) });
    for (const code of ["rejected", "expired"]) {
      const browser = new Browser(base);
      const begin = await browser.request("/auth/google");
      const state = new URL(begin.headers.get("location") ?? "").searchParams.get("state") ?? "";
      expect((await browser.request(`/auth/google/callback?code=${code}&state=${state}`)).status).toBe(400);
    }
    expect(lines).toEqual([
      "sign-in with google failed: refused: ResponseBodyError invalid",
      "sign-in with google failed: refused: ResponseBodyError invalid_grant",
    ]);
  });
});

describe.skipIf(TEST_DATABASE_URL === undefined)("sign-in against Postgres", () => {
  const name = `ogremcp_test_${randomBytes(6).toString("hex")}`;
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool({ url: TEST_DATABASE_URL ?? "", queryTimeoutMs: 10_000, max: 1 });
    await admin.query(`create database "${name}"`);
    const url = new URL(TEST_DATABASE_URL ?? "");
    url.pathname = `/${name}`;
    pool = createPool({ url: url.toString(), queryTimeoutMs: 10_000, max: 4 });
    await migrate(pool);
  });

  afterAll(async () => {
    await pool?.end();
    try {
      await admin.query(`drop database if exists "${name}" with (force)`);
    } finally {
      await admin.end();
    }
  });

  beforeEach(async () => {
    await pool.query("truncate users restart identity cascade");
  });

  async function start(): Promise<{ browser: () => Browser; tokenRequests: URLSearchParams[]; sessions: WebSessions }> {
    const { providers, tokenRequests } = fakeProviders();
    const sessions = new WebSessions({ pool, lifetimeMs: 30 * DAY_MS, renewWithinMs: 15 * DAY_MS, secure: false });
    const base = await serve({ pool, sessions, providers, publicBaseUrl: BASE, log: () => {} });
    return { browser: () => new Browser(base), tokenRequests, sessions };
  }

  /** Starts a flow and follows it back to the callback, as a provider that approves `accountId`. */
  async function signIn(browser: Browser, provider: "google" | "discord", accountId: string, link = false): Promise<Response> {
    const begin = await browser.request(`/auth/${provider}${link ? "?link=1" : ""}`);
    expect(begin.status).toBe(302);
    const state = new URL(begin.headers.get("location") ?? "").searchParams.get("state") ?? "";
    return browser.request(`/auth/${provider}/callback?code=${accountId}&state=${state}`);
  }

  async function owner(provider: string, accountId: string): Promise<string | undefined> {
    const { rows } = await pool.query<{ uuid: string }>(
      "select u.uuid from oauth_identities i join users u on u.id = i.user_id where i.provider = $1 and i.provider_user_id = $2",
      [provider, accountId],
    );
    return rows[0]?.uuid;
  }

  async function count(table: "users" | "oauth_identities" | "web_sessions"): Promise<number> {
    return Number((await pool.query<{ n: string }>(`select count(*) as n from ${table}`)).rows[0]?.n);
  }

  it("creates a user on a first sign-in and signs the same user in again", async () => {
    const { browser, tokenRequests } = await start();
    const first = browser();
    const begin = await first.request("/auth/google");
    const authorize = new URL(begin.headers.get("location") ?? "");
    expect(authorize.origin + authorize.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(authorize.searchParams.get("scope")).toBe("openid");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${BASE}/auth/google/callback`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(begin.headers.getSetCookie()[0]).toMatch(/^ogremcp_signin_google=.+; Max-Age=600; Path=\/; Expires=.+; HttpOnly; SameSite=Lax$/);

    const done = await first.request(`/auth/google/callback?code=sub-1&state=${authorize.searchParams.get("state")}`);
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe("/");
    // The verifier sent to Google's token endpoint is the one behind the challenge.
    expect(tokenRequests[0]?.get("redirect_uri")).toBe(`${BASE}/auth/google/callback`);
    const verifier = tokenRequests[0]?.get("code_verifier") ?? "";
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(authorize.searchParams.get("code_challenge"));
    const sessionCookie = done.headers.getSetCookie().find((line) => line.startsWith("ogremcp_session="));
    expect(sessionCookie).toMatch(/; Path=\/; Expires=.+; HttpOnly; SameSite=Lax$/);

    // The table holds the token's hash, and the hash finds the row.
    const token = first.cookie("ogremcp_session") ?? "";
    const { rows } = await pool.query<{ token_hash: Buffer }>("select token_hash from web_sessions");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash.equals(hashSessionToken(token))).toBe(true);
    const user = await owner("google", "sub-1");
    expect(user).toBeDefined();

    const again = browser();
    expect((await signIn(again, "google", "sub-1")).status).toBe(302);
    expect(await owner("google", "sub-1")).toBe(user);
    expect(await count("users")).toBe(1);
    expect(await count("web_sessions")).toBe(2);
  });

  it("never matches accounts by email", async () => {
    const { browser } = await start();
    await signIn(browser(), "google", "sub-1");
    await signIn(browser(), "discord", "100");
    expect(await count("users")).toBe(2);
    expect(await owner("google", "sub-1")).not.toBe(await owner("discord", "100"));
  });

  it("links a second provider when a signed-in user connects it, and only then", async () => {
    const { browser } = await start();
    const signedOut = browser();
    const refused = await signedOut.request("/auth/discord?link=1");
    expect(refused.status).toBe(401);
    expect(await refused.text()).toBe("Sign in first, then connect your Discord account.");

    const player = browser();
    await signIn(player, "google", "sub-1");
    const linked = await signIn(player, "discord", "100", true);
    expect(linked.status).toBe(302);
    expect(linked.headers.get("location")).toBe("/");
    expect(await owner("discord", "100")).toBe(await owner("google", "sub-1"));
    expect(await count("users")).toBe(1);

    // Signing in with the linked account reaches the same user.
    await signIn(browser(), "discord", "100");
    expect(await count("users")).toBe(1);
  });

  it("refuses to link an identity that belongs to another user", async () => {
    const { browser } = await start();
    await signIn(browser(), "discord", "200");
    const other = await owner("discord", "200");

    const player = browser();
    await signIn(player, "google", "sub-1");
    const res = await signIn(player, "discord", "200", true);
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(
      "This Discord account is already linked to another Ogre MCP account, so it was not connected to yours. Accounts are never merged.",
    );
    expect(await owner("discord", "200")).toBe(other);
    expect(await count("oauth_identities")).toBe(2);
  });

  it("returns to a path on this service after sign-in, and to / for any other return_to", async () => {
    const { browser } = await start();
    for (const [returnTo, location] of [
      ["/interaction/abc?x=1", "/interaction/abc?x=1"],
      ["https://evil.example/", "/"],
      ["//evil.example", "/"],
      ["/.//evil.example", "/"],
      ["/\\evil.example", "/"],
      ["/%0d%0aLocation:%20https://evil.example", "/%0d%0aLocation:%20https://evil.example"],
    ]) {
      const player = browser();
      const begin = await player.request(`/auth/google?return_to=${encodeURIComponent(returnTo ?? "")}`);
      const state = new URL(begin.headers.get("location") ?? "").searchParams.get("state") ?? "";
      const done = await player.request(`/auth/google/callback?code=sub-1&state=${state}`);
      expect(done.status).toBe(302);
      expect(done.headers.get("location")).toBe(location);
    }
  });

  it("refuses a callback whose state does not match the browser's", async () => {
    const { browser } = await start();
    const player = browser();
    await player.request("/auth/google");
    const res = await player.request("/auth/google/callback?code=sub-1&state=forged");
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Sign-in with Google could not be verified. Start again from the sign-in page.");
    // A callback with no sign-in cookie at all.
    expect((await browser().request("/auth/google/callback?code=sub-1&state=forged")).status).toBe(400);
    expect(await count("users")).toBe(0);
  });

  it("signs out on a POST from this site only", async () => {
    const { browser } = await start();
    const player = browser();
    await signIn(player, "google", "sub-1");

    const forged = await player.request("/auth/signout", { method: "POST", headers: { origin: "https://evil.example" } });
    expect(forged.status).toBe(403);
    expect(await count("web_sessions")).toBe(1);
    expect((await player.request("/auth/signout", { method: "POST" })).status).toBe(403);

    const res = await player.request("/auth/signout", { method: "POST", headers: { origin: BASE } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(await count("web_sessions")).toBe(0);
    expect(player.cookie("ogremcp_session")).toBeUndefined();
  });

  it("expires a web session, and renews it when less than the window is left", async () => {
    const { rows } = await pool.query<{ id: string }>("insert into users default values returning id");
    const userId = rows[0]?.id ?? "";
    let now = new Date("2026-09-01T00:00:00Z");
    const sessions = new WebSessions({ pool, lifetimeMs: 30 * DAY_MS, renewWithinMs: 15 * DAY_MS, secure: true, now: () => now });
    expect(sessions.cookieName).toBe("__Host-ogremcp_session");
    const { token, expiresAt } = await sessions.create(userId);
    expect(expiresAt).toEqual(new Date("2026-10-01T00:00:00Z"));

    now = new Date("2026-09-10T00:00:00Z");
    expect(await sessions.validate(token)).toMatchObject({ user: { id: userId }, renewed: false, expiresAt });
    expect(await sessions.validate(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`)).toBeNull();

    // 14 days left: renewed to 30 days from now.
    now = new Date("2026-09-17T00:00:00Z");
    const renewed = await sessions.validate(token);
    expect(renewed).toMatchObject({ renewed: true, expiresAt: new Date("2026-10-17T00:00:00Z") });

    now = new Date("2026-10-17T00:00:00Z");
    expect(await sessions.validate(token)).toBeNull();
    expect(await count("web_sessions")).toBe(0);
  });
});
