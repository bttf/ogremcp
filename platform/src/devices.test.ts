import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express, { type RequestHandler } from "express";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { createPool } from "./db.js";
import { BRIDGE_CLIENT_ID, DEVICE_CODE_GRANT, revokeDevice } from "./devices.js";
import { migrate } from "./migrations.js";
import { createOidcProvider, type OidcOptions } from "./oidc.js";
import { PostgresAdapter } from "./oidc-adapter.js";
import { generateOidcKeys } from "./oidc-keys.js";
import { currentToken, requireToken, resourcesOf } from "./oidc-tokens.js";
import { WebSessions } from "./web-sessions.js";

/** As in migrations.test.ts: a Postgres server whose user may create databases. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"]?.trim() || undefined;
if (TEST_DATABASE_URL === undefined) console.warn("TEST_DATABASE_URL is not set: the Postgres tests in devices.test.ts are skipped");

const ISSUER = "http://localhost:4790";
const RESOURCES = resourcesOf(ISSUER);
const DAY_MS = 24 * 60 * 60 * 1000;

const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server.listen(0, "127.0.0.1"));
  await once(server, "listening");
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterAll(() => {
  for (const server of servers) server.close();
});

/** A device authorization request, as the bridge (RED-317) sends it. */
async function deviceAuth(base: string, params: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/oauth/device/auth`, { method: "POST", body: new URLSearchParams(params) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("the device flow's clients", () => {
  /** Serves client ID metadata documents at /<name>.json. */
  const documents = new Map<string, Record<string, unknown>>();
  let docHost: string;
  let base: string;

  beforeAll(async () => {
    docHost = await listen(
      createServer((req, res) => {
        const document = documents.get(req.url ?? "");
        if (document === undefined) return void res.writeHead(404).end();
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(document));
      }),
    );
    // No refusal below reaches a model but the CIMD client's document, and a stored client, which there is none of.
    const noClients = { query: () => Promise.resolve({ rows: [], rowCount: 0 }) } as unknown as Pool;
    const testOnlyFetch: OidcOptions["testOnlyFetch"] = (input) => fetch(`http://${docHost}${new URL(input instanceof Request ? input.url : input).pathname}`);
    const oidc = createOidcProvider({ pool: noClients, issuer: ISSUER, keys: generateOidcKeys(), trustProxyHops: 0, log: () => {}, testOnlyFetch });
    const sessions = new WebSessions({ pool: noClients, lifetimeMs: DAY_MS, renewWithinMs: DAY_MS, secure: false });
    const app = createApp({
      health: { checkDatabase: () => Promise.resolve() },
      auth: { pool: noClients, sessions, providers: { google: null, discord: null }, publicBaseUrl: ISSUER },
      oidc,
    });
    base = `http://${await listen(createServer(app))}`;
  });

  it("refuses a CIMD client that names the device code grant, and the bridge any other resource or scope", async () => {
    documents.set("/device.json", {
      client_id: `https://${docHost}/device.json`,
      client_name: "Not the bridge",
      token_endpoint_auth_method: "none",
      grant_types: [DEVICE_CODE_GRANT, "refresh_token"],
      response_types: [],
    });
    const cimd = await deviceAuth(base, { client_id: `https://${docHost}/device.json`, scope: "ingest" });
    expect(cimd.status).toBe(400);
    expect(cimd.body["error_description"]).toMatch(/grant_types may not hold the device code grant/);

    expect((await deviceAuth(base, { client_id: BRIDGE_CLIENT_ID, scope: "read" })).body["error"]).toBe("invalid_scope");
    expect((await deviceAuth(base, { client_id: BRIDGE_CLIENT_ID, scope: "ingest", resource: RESOURCES.mcp })).body["error"]).toBe("invalid_target");
  });
});

/** A browser's cookie jar, enough for these flows. Paths are ignored, so every cookie goes with every request. */
class Browser {
  readonly cookies = new Map<string, string>();
  constructor(private readonly origin: string) {}

  async send(method: "GET" | "POST", path: string, accept: string, form?: Record<string, string>): Promise<Response> {
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    const res = await fetch(path.startsWith("http") ? path : `${this.origin}${path}`, {
      method,
      redirect: "manual",
      headers: { accept, ...(cookie === "" ? {} : { cookie }) },
      ...(form === undefined ? {} : { body: new URLSearchParams(form) }),
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

  /** A call of the Device approval page's, which answers JSON. */
  async call(form?: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.send(form === undefined ? "GET" : "POST", "/device", "application/json", form);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  /** A form post of the page, followed through its redirects to where it sends the browser back. */
  async submit(form: Record<string, string>): Promise<string> {
    let res = await this.send("POST", "/device", "text/html", form);
    for (let hops = 0; hops < 10 && res.status === 303; hops++) {
      const location = res.headers.get("location") ?? "";
      if (location.startsWith("/device?")) return location;
      res = await this.send("GET", location, "text/html");
    }
    throw new Error(`the form post ended at ${res.status}`);
  }
}

describe.skipIf(TEST_DATABASE_URL === undefined)("the device flow against Postgres", () => {
  const name = `ogmcp_test_${randomBytes(6).toString("hex")}`;
  let admin: Pool;
  let pool: Pool;
  let sessions: WebSessions;
  let oidc: ReturnType<typeof createOidcProvider>;
  let base: string;
  let webRoot: string;

  beforeAll(async () => {
    webRoot = mkdtempSync(join(tmpdir(), "ogmcp-web-"));
    writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>web</title>");
    admin = createPool({ url: TEST_DATABASE_URL ?? "", queryTimeoutMs: 10_000, max: 1 });
    await admin.query(`create database "${name}"`);
    const url = new URL(TEST_DATABASE_URL ?? "");
    url.pathname = `/${name}`;
    pool = createPool({ url: url.toString(), queryTimeoutMs: 10_000, max: 4 });
    await migrate(pool);
    // An agent client, as dynamic registration stores one.
    await new PostgresAdapter(pool, "Client").upsert("agent", {
      client_id: "agent",
      redirect_uris: ["https://agent.example/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    sessions = new WebSessions({ pool, lifetimeMs: 30 * DAY_MS, renewWithinMs: 15 * DAY_MS, secure: false });
    oidc = createOidcProvider({ pool, issuer: ISSUER, keys: generateOidcKeys(), trustProxyHops: 0, log: () => {} });
    // A stand-in for the ingest endpoint (RED-313), ahead of the service's own routes.
    const outer = express();
    const answer: RequestHandler = (_req, res) => {
      res.json(currentToken(res));
    };
    outer.post("/api/v1/ingest", requireToken({ provider: oidc, resource: RESOURCES.bridge, scope: "ingest" }), answer);
    outer.use(
      createApp({
        health: { checkDatabase: () => Promise.resolve() },
        auth: { pool, sessions, providers: { google: null, discord: null }, publicBaseUrl: ISSUER, log: () => {} },
        oidc,
        webRoot,
      }),
    );
    base = `http://${await listen(createServer(outer))}`;
  });

  afterAll(async () => {
    rmSync(webRoot, { recursive: true, force: true });
    await pool?.end();
    try {
      await admin.query(`drop database if exists "${name}" with (force)`);
    } finally {
      await admin.end();
    }
  });

  /** Signs the browser in as a new user. Answers the user's `users.id`. */
  async function signIn(browser: Browser): Promise<string> {
    const { rows } = await pool.query<{ id: string }>("insert into users default values returning id");
    const id = rows[0]?.id ?? "";
    browser.cookies.set(sessions.cookieName, (await sessions.create(id)).token);
    return id;
  }

  async function token(params: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${base}/oauth/token`, { method: "POST", body: new URLSearchParams({ client_id: BRIDGE_CLIENT_ID, ...params }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  /** A POST to `path` with an access token and the issuer's Host, which `/mcp` checks. `fetch` cannot set it. */
  async function call(path: string, accessToken: string): Promise<number> {
    const { port } = new URL(base);
    return new Promise((resolve, reject) => {
      const headers = { host: new URL(ISSUER).host, authorization: `Bearer ${accessToken}` };
      const req = request({ host: "127.0.0.1", port, method: "POST", path, headers }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end();
    });
  }

  /** A bridge's approval in `browser`, from its device authorization request to its first tokens. */
  async function approveBridge(browser: Browser): Promise<{ accessToken: string; refreshToken: string }> {
    const started = await deviceAuth(base, { client_id: BRIDGE_CLIENT_ID, scope: "ingest" });
    expect(started.status).toBe(200);
    const deviceCode = String(started.body["device_code"]);
    const userCode = String(started.body["user_code"]);
    expect(userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(started.body["verification_uri"]).toBe(`${base}/device`);
    expect((await token({ grant_type: DEVICE_CODE_GRANT, device_code: deviceCode })).body["error"]).toBe("authorization_pending");

    const entered = await browser.call();
    expect(entered).toMatchObject({ status: 200, body: { step: "enter", xsrf: expect.any(String) } });
    const xsrf = String(entered.body["xsrf"]);
    const confirm = await browser.call({ xsrf, user_code: userCode.toLowerCase().replace("-", " ") });
    expect(confirm.body).toEqual({ step: "confirm", xsrf, user_code: userCode, client_name: "Open Gamer MCP bridge" });
    expect(await browser.submit({ xsrf, user_code: userCode, confirm: "yes" })).toBe("/device?result=approved");

    const issued = await token({ grant_type: DEVICE_CODE_GRANT, device_code: deviceCode });
    expect(issued.status).toBe(200);
    expect(issued.body).toMatchObject({ token_type: "Bearer", scope: "ingest", refresh_token: expect.any(String) });
    return { accessToken: String(issued.body["access_token"]), refreshToken: String(issued.body["refresh_token"]) };
  }

  it("approves a bridge at /device: a devices row, an ingest token for the bridge API only, and a grant per device", async () => {
    const browser = new Browser(base);
    // A page load gets the web UI, and signed out, the page's calls are refused.
    expect(await (await browser.send("GET", "/device?user_code=BCDF-GHJK", "text/html")).text()).toBe("<!doctype html><title>web</title>");
    expect(await browser.call()).toEqual({ status: 401, body: { error: "signed_out" } });
    const userId = await signIn(browser);

    const first = await approveBridge(browser);
    expect(await call("/api/v1/ingest", first.accessToken)).toBe(200);
    expect(await call("/mcp", first.accessToken)).toBe(401);
    // The same browser approves a second bridge.
    await approveBridge(browser);

    const { rows } = await pool.query<{ grant_id: string; os: string | null; bridge_version: string | null }>(
      "select grant_id, os, bridge_version from devices where user_id = $1 order by id",
      [userId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.grant_id).not.toBe(rows[1]?.grant_id);
    expect(rows.every((row) => row.os === null && row.bridge_version === null)).toBe(true);
  });

  it("denies a bridge at /device, and the bridge's poll gets access_denied", async () => {
    const browser = new Browser(base);
    await signIn(browser);
    const started = await deviceAuth(base, { client_id: BRIDGE_CLIENT_ID, scope: "ingest" });
    const xsrf = String((await browser.call()).body["xsrf"]);
    const userCode = String(started.body["user_code"]);
    expect(await browser.submit({ xsrf, user_code: userCode, abort: "yes" })).toBe("/device?result=denied");
    expect((await token({ grant_type: DEVICE_CODE_GRANT, device_code: String(started.body["device_code"]) })).body["error"]).toBe("access_denied");
  });

  it("revokes a device: its tokens are refused, its refresh token fails, and other devices keep theirs", async () => {
    const browser = new Browser(base);
    const userId = await signIn(browser);
    const revoked = await approveBridge(browser);
    const kept = await approveBridge(browser);
    const { rows } = await pool.query<{ uuid: string }>("select uuid from devices where user_id = $1 order by id", [userId]);
    const deviceUuid = rows[0]?.uuid ?? "";

    // Another user's device is not theirs to revoke.
    expect(await revokeDevice(pool, await signIn(new Browser(base)), deviceUuid)).toBe(false);
    expect(await revokeDevice(pool, userId, deviceUuid)).toBe(true);
    expect(await revokeDevice(pool, userId, deviceUuid)).toBe(false);

    expect(await call("/api/v1/ingest", revoked.accessToken)).toBe(401);
    expect((await token({ grant_type: "refresh_token", refresh_token: revoked.refreshToken })).body["error"]).toBe("invalid_grant");
    const row = await pool.query("select 1 from devices where uuid = $1 and revoked_at is not null", [deviceUuid]);
    expect(row.rowCount).toBe(1);
    expect(await call("/api/v1/ingest", kept.accessToken)).toBe(200);
  });

  it("refuses the device flow to a registered agent client", async () => {
    const res = await deviceAuth(base, { client_id: "agent", scope: "ingest" });
    expect(res).toMatchObject({ status: 400, body: { error_description: `${DEVICE_CODE_GRANT} is not allowed for this client` } });
  });
});
