import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type Provider from "oidc-provider";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { ADAPTER_SHA256_HEADER, type KitList } from "./bridge-api.js";
import { createPool } from "./db.js";
import { writeAdapterZips } from "./kits/adapter.js";
import { KIT_SOURCES, type KitRegistry, loadKitRegistry } from "./kits/registry.js";
import { checkKits } from "./kits/validate.js";
import { migrate } from "./migrations.js";
import { createOidcProvider } from "./oidc.js";
import { PostgresAdapter } from "./oidc-adapter.js";
import { generateOidcKeys } from "./oidc-keys.js";
import { resourcesOf, type Scope } from "./oidc-tokens.js";
import { WebSessions } from "./web-sessions.js";

/** As in migrations.test.ts: a Postgres server whose user may create databases. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"]?.trim() || undefined;
if (TEST_DATABASE_URL === undefined) console.warn("TEST_DATABASE_URL is not set: the Postgres tests in bridge-api.test.ts are skipped");

const ISSUER = "http://localhost:4790";
const RESOURCES = resourcesOf(ISSUER);
const CLIENT_ID = "test-client";
const DAY_MS = 24 * 60 * 60 * 1000;
const PATHS = ["/api/v1/kits", "/api/v1/kits/wow/manifest", "/api/v1/kits/wow/adapter"];

describe.skipIf(TEST_DATABASE_URL === undefined)("the bridge's kit endpoints (§8.2)", () => {
  const name = `ogmcp_test_${randomBytes(6).toString("hex")}`;
  let admin: Pool;
  let pool: Pool;
  let provider: Provider;
  let adaptersDir: string;
  let kits: KitRegistry;
  let server: Server | undefined;
  let base: string;

  beforeAll(async () => {
    adaptersDir = mkdtempSync(join(tmpdir(), "ogmcp-adapters-"));
    writeAdapterZips(checkKits(KIT_SOURCES), adaptersDir);
    kits = loadKitRegistry({ adaptersDir });

    admin = createPool({ url: TEST_DATABASE_URL ?? "", queryTimeoutMs: 10_000, max: 1 });
    await admin.query(`create database "${name}"`);
    const url = new URL(TEST_DATABASE_URL ?? "");
    url.pathname = `/${name}`;
    pool = createPool({ url: url.toString(), queryTimeoutMs: 10_000, max: 4 });
    await migrate(pool);
    // The device flow is RED-307: the client and grant below stand in for a bridge's.
    await new PostgresAdapter(pool, "Client").upsert(CLIENT_ID, {
      client_id: CLIENT_ID,
      redirect_uris: ["https://agent.example/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    provider = createOidcProvider({ pool, issuer: ISSUER, keys: generateOidcKeys(), trustProxyHops: 0, log: () => {} });
    const sessions = new WebSessions({ pool, lifetimeMs: DAY_MS, renewWithinMs: DAY_MS, secure: false });
    const app = createApp({
      health: { checkDatabase: () => Promise.resolve() },
      auth: { pool, sessions, providers: { google: null, discord: null }, publicBaseUrl: ISSUER, log: () => {} },
      oidc: provider,
      kits,
    });
    server = createServer(app).listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.close();
    rmSync(adaptersDir, { recursive: true, force: true });
    await pool?.end();
    try {
      await admin.query(`drop database if exists "${name}" with (force)`);
    } finally {
      await admin.end();
    }
  });

  /** A new user's access token for `resource` with `scope`, as oidc-tokens.test.ts mints them. */
  async function token(resource: string, scope: Scope): Promise<{ userId: string; accessToken: string }> {
    const { rows } = await pool.query<{ id: string; uuid: string }>("insert into users default values returning id, uuid");
    const user = rows[0];
    if (user === undefined) throw new Error("no user row");
    const client = await provider.Client.find(CLIENT_ID);
    if (client === undefined) throw new Error("the test client is missing");
    const grant = new provider.Grant({ accountId: user.uuid, clientId: CLIENT_ID });
    grant.addResourceScope(resource, scope);
    const grantId = await grant.save();
    const refreshToken = await new provider.RefreshToken({ accountId: user.uuid, client, grantId, gty: "authorization_code", scope, resource }).save();
    const res = await fetch(`${base}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken }),
    });
    const body = (await res.json()) as { access_token?: string; scope?: string };
    expect(body.scope).toBe(scope);
    return { userId: user.id, accessToken: body.access_token ?? "" };
  }

  function get(path: string, accessToken?: string): Promise<Response> {
    return fetch(`${base}${path}`, { headers: accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` } });
  }

  it("lists the user's enabled kits, and serves any kit's manifest and adapter zip", async () => {
    const bridge = await token(RESOURCES.bridge, "ingest");
    const wow = kits.get("wow");
    if (wow?.adapter == null) throw new Error("the WoW kit has no adapter");

    const none = await get("/api/v1/kits", bridge.accessToken);
    expect(none.status).toBe(200);
    expect(none.headers.get("cache-control")).toBe("no-store");
    expect(await none.json()).toEqual({ kits: [] });

    // Not enabled: the manifest and adapter are served all the same.
    const manifest = await get("/api/v1/kits/wow/manifest", bridge.accessToken);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("cache-control")).toBe("no-store");
    expect(await manifest.json()).toEqual(wow.manifest);

    const adapter = await get("/api/v1/kits/wow/adapter", bridge.accessToken);
    expect(adapter.status).toBe(200);
    expect(adapter.headers.get("cache-control")).toBe("no-store");
    expect(adapter.headers.get("content-type")).toBe("application/zip");
    const zip = Buffer.from(await adapter.arrayBuffer());
    expect(zip.equals(wow.adapter.data)).toBe(true);
    expect(adapter.headers.get(ADAPTER_SHA256_HEADER)).toBe(createHash("sha256").update(zip).digest("hex"));

    await pool.query("insert into user_games (user_id, kit) values ($1, 'wow')", [bridge.userId]);
    const list: KitList = {
      kits: [{ kit: "wow", manifest_version: wow.manifest.version, adapter: { version: wow.adapter.version, sha256: wow.adapter.sha256 } }],
    };
    expect(await (await get("/api/v1/kits", bridge.accessToken)).json()).toEqual(list);

    const unknown = await get("/api/v1/kits/nope/manifest", bridge.accessToken);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "unknown_kit" });
  });

  it("refuses a request without a token, and an agent's read token", async () => {
    const agent = await token(RESOURCES.mcp, "read");
    for (const path of PATHS) {
      const missing = await get(path);
      expect(missing.status, path).toBe(401);
      expect(missing.headers.get("www-authenticate")).toBe('Bearer scope="ingest"');
      expect(missing.headers.get("cache-control")).toBe("no-store");

      const read = await get(path, agent.accessToken);
      expect(read.status, path).toBe(401);
      expect(read.headers.get("www-authenticate")).toBe(
        'Bearer error="invalid_token", error_description="the access token is not valid here", scope="ingest"',
      );
    }
  });
});
