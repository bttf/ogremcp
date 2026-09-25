import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import type Provider from "oidc-provider";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "./app.js";
import { createPool } from "./db.js";
import { BRIDGE_CLIENT_ID, createDevice } from "./devices.js";
import { createEventRecorder } from "./events.js";
import { DEFAULT_INGEST, type IngestAnswer, type IngestMeta, type IngestSettings } from "./ingest.js";
import { writeAdapterZips } from "./kits/adapter.js";
import { KIT_SOURCES, type Kit, type KitRegistry, loadKitRegistry } from "./kits/registry.js";
import { checkKits } from "./kits/validate.js";
import { migrate } from "./migrations.js";
import { createOidcProvider } from "./oidc.js";
import { PostgresAdapter } from "./oidc-adapter.js";
import { generateOidcKeys } from "./oidc-keys.js";
import { resourcesOf } from "./oidc-tokens.js";
import { WebSessions } from "./web-sessions.js";

/** As in migrations.test.ts: a Postgres server whose user may create databases. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"]?.trim() || undefined;
if (TEST_DATABASE_URL === undefined) console.warn("TEST_DATABASE_URL is not set: the Postgres tests in ingest.test.ts are skipped");

const ISSUER = "http://localhost:4790";
const RESOURCES = resourcesOf(ISSUER);
const AGENT_CLIENT_ID = "test-agent";
const DAY_MS = 24 * 60 * 60 * 1000;
const MIB = 1024 * 1024;

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The `client` facts of a Classic Era client (§6.3.1). */
const CLASSIC_ERA_CLIENT = `{ ["project_id"] = 2, ["interface"] = 11509 }`;

/** A SavedVariables file the WoW interpreter parses (§6.3), with synthetic data. */
function savedVariables(capturedAt: number, zone = "Elwynn Forest", client = CLASSIC_ERA_CLIENT): string {
  return `OpenGamerMCPDB = {
  ["schema"] = 1,
  ["client"] = ${client},
  ["character"] = { ["guid"] = "Player-0000-00000001", ["name"] = "Zoela", ["realm"] = "Testrealm" },
  ["captured_at"] = ${capturedAt},
  ["state"] = { ["location"] = { ["zone"] = "${zone}" } },
}
`;
}

const CAPTURED_AT = 1_790_000_000;
const INSTANCE = sha256("_classic_era_/WTF/Account/TEST/SavedVariables/OpenGamerMCP.lua");

/** An upload of `text`: its gzip and its §8.3 meta, with `meta` over the defaults. */
function upload(text: string | Buffer, meta: Partial<IngestMeta> = {}): { gz: Buffer; meta: IngestMeta } {
  const bytes = Buffer.from(text);
  return {
    gz: gzipSync(bytes),
    meta: {
      kit: "wow",
      source_id: "savedvariables",
      instance: INSTANCE,
      sha256: sha256(bytes),
      mtime: "2026-09-24T18:02:11Z",
      client: { bridge_version: "0.1.0", os: "windows", errors: { locate_failed: 0, upload_failed: 2 } },
      ...meta,
    },
  };
}

describe.skipIf(TEST_DATABASE_URL === undefined)("POST /api/v1/ingest (§8.3)", () => {
  const name = `ogmcp_test_${randomBytes(6).toString("hex")}`;
  let admin: Pool;
  let pool: Pool;
  let provider: Provider;
  let adaptersDir: string;
  let kits: KitRegistry;
  let sessions: WebSessions;
  const servers: Server[] = [];
  let base: string;
  /** What the ingest endpoint logged. */
  const logged: string[] = [];

  /** Serves the app with the ingest limits `ingest`, and answers its base URL. */
  async function serve(ingest: IngestSettings, registry = kits): Promise<string> {
    const app = createApp({
      health: { checkDatabase: () => Promise.resolve() },
      auth: { pool, sessions, providers: { google: null, discord: null }, publicBaseUrl: ISSUER, log: () => {} },
      oidc: provider,
      kits: registry,
      ingest,
      ingestLog: (line) => logged.push(line),
      events: createEventRecorder({ pool }),
      log: () => {},
    });
    const server = createServer(app).listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

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
    await new PostgresAdapter(pool, "Client").upsert(AGENT_CLIENT_ID, {
      client_id: AGENT_CLIENT_ID,
      redirect_uris: ["https://agent.example/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    provider = createOidcProvider({ pool, issuer: ISSUER, keys: generateOidcKeys(), trustProxyHops: 0, log: () => {} });
    sessions = new WebSessions({ pool, lifetimeMs: DAY_MS, renewWithinMs: DAY_MS, secure: false });
    // The tests post one instance several times in a row. The rate limit's test has its own server.
    base = await serve({ ...DEFAULT_INGEST, burst: 1_000, deviceBurst: 1_000 });
  });

  afterAll(async () => {
    for (const server of servers) server.close();
    rmSync(adaptersDir, { recursive: true, force: true });
    await pool?.end();
    try {
      await admin.query(`drop database if exists "${name}" with (force)`);
    } finally {
      await admin.end();
    }
  });

  async function newUser(): Promise<{ id: string; uuid: string }> {
    const { rows } = await pool.query<{ id: string; uuid: string }>("insert into users default values returning id, uuid");
    if (rows[0] === undefined) throw new Error("no user row");
    return rows[0];
  }

  /**
   * An access token of `user` for the bridge API with `ingest`, as an approved
   * bridge gets one (devices.test.ts), or an agent's for the MCP server with
   * `read`. `deviceOf` is the user whose `devices` row gets the bridge's
   * grant; null makes none.
   */
  async function token(
    user: { id: string; uuid: string },
    scope: "ingest" | "read" = "ingest",
    deviceOf: { id: string } | null = user,
  ): Promise<{ accessToken: string; deviceId: string | null }> {
    const bridge = scope === "ingest";
    const resource = bridge ? RESOURCES.bridge : RESOURCES.mcp;
    const clientId = bridge ? BRIDGE_CLIENT_ID : AGENT_CLIENT_ID;
    const client = await provider.Client.find(clientId);
    if (client === undefined) throw new Error("the client is missing");
    const grant = new provider.Grant({ accountId: user.uuid, clientId });
    grant.addResourceScope(resource, scope);
    const grantId = await grant.save();
    let deviceId: string | null = null;
    if (bridge && deviceOf !== null) {
      await createDevice(pool, deviceOf.id, grantId);
      const { rows } = await pool.query<{ id: string }>("select id from devices where grant_id = $1", [grantId]);
      deviceId = rows[0]?.id ?? null;
    }
    const gty = bridge ? "device_code" : "authorization_code";
    const refreshToken = await new provider.RefreshToken({ accountId: user.uuid, client, grantId, gty, scope, resource }).save();
    const res = await fetch(`${base}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({ client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken }),
    });
    const body = (await res.json()) as { access_token?: string };
    return { accessToken: body.access_token ?? "", deviceId };
  }

  /** Posts an upload as the bridge sends it: `meta` as a form field, `file` as a file part. */
  async function post(
    accessToken: string,
    { gz, meta }: { gz: Buffer; meta: IngestMeta },
    to = base,
  ): Promise<{ res: Response; body: IngestAnswer | null }> {
    const form = new FormData();
    form.append("meta", JSON.stringify(meta));
    form.append("file", new Blob([new Uint8Array(gz)]), "OpenGamerMCP.lua.gz");
    const res = await fetch(`${to}/api/v1/ingest`, { method: "POST", headers: { authorization: `Bearer ${accessToken}` }, body: form });
    const text = await res.text();
    const json = res.headers.get("content-type")?.startsWith("application/json") === true;
    return { res, body: json ? (JSON.parse(text) as IngestAnswer) : null };
  }

  async function uploadsOf(deviceId: string | null) {
    const { rows } = await pool.query<Record<string, unknown>>("select * from uploads where device_id = $1 order by id", [deviceId]);
    return rows;
  }

  /** The device's events rows (§16.1), once there are `count` of them, oldest first. */
  async function eventsOf(deviceId: string | null, count: number) {
    return vi.waitFor(async () => {
      const { rows } = await pool.query<Record<string, unknown>>("select * from events where device_id = $1 order by occurred_at, id", [deviceId]);
      expect(rows).toHaveLength(count);
      return rows;
    });
  }

  async function deviceRow(deviceId: string | null) {
    const { rows } = await pool.query<Record<string, unknown>>("select * from devices where id = $1", [deviceId]);
    return rows[0] ?? {};
  }

  it("stores the upload and its snapshot, and stores nothing for the same bytes again", async () => {
    const user = await newUser();
    const { accessToken, deviceId } = await token(user);
    const first = upload(savedVariables(CAPTURED_AT));

    const stored = await post(accessToken, first);
    expect(stored.res.status).toBe(201);
    expect(stored.res.headers.get("cache-control")).toBe("no-store");
    expect(stored.body).toEqual({ status: "stored", snapshot_uuid: expect.stringMatching(/^[0-9a-f-]{36}$/) });

    const [row] = await uploadsOf(deviceId);
    expect(row).toMatchObject({
      user_id: user.id,
      kit: "wow",
      source_id: "savedvariables",
      instance: INSTANCE,
      sha256: first.meta.sha256,
      mtime: new Date("2026-09-24T18:02:11Z"),
      kit_version: kits.get("wow")?.manifest.version,
      adapter_schema: 1,
      parse_status: "parsed",
      parse_error: null,
      client_errors: { locate_failed: 0, upload_failed: 2 },
    });
    expect((row?.["content_gzip"] as Buffer).equals(first.gz)).toBe(true);
    const { rows: snapshots } = await pool.query("select * from snapshots where upload_id = $1", [row?.["id"]]);
    expect(snapshots[0]).toMatchObject({
      uuid: stored.body?.snapshot_uuid,
      user_id: user.id,
      kit: "wow",
      flavor: "classic_era",
      rules: [],
      character_key: "Player-0000-00000001",
      character_name: "Zoela",
      character_realm: "Testrealm",
      snapshot_at: new Date(CAPTURED_AT * 1000),
      state: { location: { zone: "Elwynn Forest" } },
    });
    const seen = await deviceRow(deviceId);
    expect(seen).toMatchObject({ os: "windows", bridge_version: "0.1.0", last_seen_at: expect.any(Date), first_upload_at: expect.any(Date) });

    const duplicate = await post(accessToken, { ...first, meta: { ...first.meta, client: { bridge_version: "0.1.1", os: "windows" } } });
    expect(duplicate.res.status).toBe(200);
    expect(duplicate.body).toEqual({ status: "duplicate" });
    expect(await uploadsOf(deviceId)).toHaveLength(1);
    const again = await deviceRow(deviceId);
    expect((again["last_seen_at"] as Date).getTime()).toBeGreaterThan((seen["last_seen_at"] as Date).getTime());
    expect(again).toMatchObject({ bridge_version: "0.1.1", first_upload_at: seen["first_upload_at"] });

    // snapshot_at: without an adapter stamp, the mtime; without an mtime too, the receipt time.
    const noStamp = upload(savedVariables(0, "Westfall"));
    const withMtime = await post(accessToken, noStamp);
    const noMtime = await post(accessToken, upload(savedVariables(0, "Duskwood"), { mtime: null }));
    const { rows: fallbacks } = await pool.query<{ uuid: string; snapshot_at: Date; received_at: Date; mtime: Date | null }>(
      "select s.uuid, s.snapshot_at, u.received_at, u.mtime from snapshots s join uploads u on u.id = s.upload_id where s.uuid = any($1) order by s.id",
      [[withMtime.body?.snapshot_uuid, noMtime.body?.snapshot_uuid]],
    );
    expect(fallbacks[0]?.snapshot_at).toEqual(new Date("2026-09-24T18:02:11Z"));
    expect(fallbacks[1]?.mtime).toBeNull();
    expect(fallbacks[1]?.snapshot_at).toEqual(fallbacks[1]?.received_at);

    // meta.sha256 is checked against the bytes, since dedup trusts it.
    const wrongSha = await post(accessToken, { ...noStamp, meta: { ...noStamp.meta, sha256: sha256("other") } });
    expect(wrongSha.res.status).toBe(400);
    expect(wrongSha.body?.status).toBe("bad_request");
  });

  it("records one event per answer, with what it knew of the upload by then, and none for bad_request (§16.1)", async () => {
    const user = await newUser();
    const { accessToken, deviceId } = await token(user);
    const good = upload(savedVariables(CAPTURED_AT));
    const tbc = upload(savedVariables(CAPTURED_AT, "Hellfire Peninsula", `{ ["project_id"] = 5, ["interface"] = 20506 }`));
    const statuses = [
      await post(accessToken, good),
      await post(accessToken, good),
      await post(accessToken, upload("OpenGamerMCPDB = os.exit()")),
      await post(accessToken, tbc),
      await post(accessToken, upload(savedVariables(CAPTURED_AT), { kit: "nope" })),
      await post(accessToken, { ...good, meta: { ...good.meta, pad: "x".repeat(20_000) } as IngestMeta }),
    ].map(({ body }) => body?.status);
    expect(statuses).toEqual(["stored", "duplicate", "parse_error", "unsupported_flavor", "bad_request", "too_large"]);

    const rows = await eventsOf(deviceId, 5);
    const version = kits.get("wow")?.manifest.version;
    const client = { bridge_version: "0.1.0", os: "windows", client_errors: { locate_failed: 0, upload_failed: 2 } };
    expect(rows.map((row) => [row["status"], row["parse_status"], row["flavor"], row["adapter_schema"], row["kit"], row["kit_version"]])).toEqual([
      ["stored", "parsed", "classic_era", 1, "wow", version],
      ["duplicate", null, null, null, "wow", version],
      ["parse_error", "failed", null, null, "wow", version],
      ["unsupported_flavor", "rejected", "tbc_classic", 1, "wow", version],
      // Refused before meta was read: nothing of it.
      ["too_large", null, null, null, null, null],
    ]);
    for (const row of rows.slice(0, 4)) {
      expect(row).toMatchObject({ kind: "ingest", user_id: user.id, device_id: deviceId, latency_ms: expect.any(Number), ...client });
    }
    expect(rows[4]).toMatchObject({ user_id: user.id, bridge_version: null, os: null, client_errors: null, agent_client: null, tool: null });
  });

  it("records an interpreter crash as an error event, and answers 500", async () => {
    const wow = kits.get("wow");
    if (wow === undefined) throw new Error("no wow kit");
    const crashing: Kit = {
      ...wow,
      interpreter: {
        ...wow.interpreter,
        parse: () => {
          throw new TypeError("a kit bug");
        },
      },
    };
    const crashBase = await serve(DEFAULT_INGEST, { list: () => [crashing], get: (key) => (key === "wow" ? crashing : undefined) });
    const { accessToken, deviceId } = await token(await newUser());

    const res = await post(accessToken, upload(savedVariables(CAPTURED_AT)), crashBase);
    expect(res.res.status).toBe(500);
    expect(await uploadsOf(deviceId)).toHaveLength(0);
    const [row] = await eventsOf(deviceId, 1);
    expect(row).toMatchObject({
      status: "error",
      kit: "wow",
      kit_version: wow.manifest.version,
      parse_status: null,
      adapter_schema: null,
      bridge_version: "0.1.0",
    });
  });

  it("answers a gzip bomb with too_large and stores nothing", async () => {
    const { accessToken, deviceId } = await token(await newUser());
    const bomb = upload(Buffer.alloc(64 * MIB));
    expect(bomb.gz.length).toBeLessThan(MIB);
    const res = await post(accessToken, bomb);
    expect(res.res.status).toBe(413);
    expect(res.body?.status).toBe("too_large");
    expect(await uploadsOf(deviceId)).toHaveLength(0);
  });

  it("keeps an upload that fails to parse, for a re-parse, and answers parse_error", async () => {
    const { accessToken, deviceId } = await token(await newUser());
    const bad = upload("OpenGamerMCPDB = os.exit()");
    const res = await post(accessToken, bad);
    expect(res.res.status).toBe(422);
    expect(res.body).toEqual({ status: "parse_error", message: expect.stringMatching(/^OpenGamerMCP\.lua could not be read/) });

    const rows = await uploadsOf(deviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ parse_status: "failed", parse_error: res.body?.message, adapter_schema: null, sha256: bad.meta.sha256 });
    expect((rows[0]?.["content_gzip"] as Buffer).equals(bad.gz)).toBe(true);
    const snapshots = await pool.query("select 1 from snapshots where upload_id = $1", [rows[0]?.["id"]]);
    expect(snapshots.rowCount).toBe(0);
    expect((await deviceRow(deviceId))["first_upload_at"]).toEqual(expect.any(Date));
  });

  it("keeps an unregistered or unknown flavor's upload without a snapshot, and stores an experimental one", async () => {
    const user = await newUser();
    const { accessToken, deviceId } = await token(user);
    logged.length = 0;
    const unsupported = { status: "unsupported_flavor", message: "This version of World of Warcraft isn't supported yet." };

    // TBC Classic maps to a flavor the manifest does not register (§6.3.1).
    const tbc = await post(accessToken, upload(savedVariables(CAPTURED_AT, "Hellfire Peninsula", `{ ["project_id"] = 5, ["interface"] = 20506 }`)));
    expect(tbc.res.status).toBe(422);
    expect(tbc.body).toEqual(unsupported);
    expect(logged).toEqual([]);

    // A Classic Era project ID with a Mists Classic interface fails the sanity check.
    const mismatch = `{ ["project_id"] = 2, ["interface"] = 50504, ["build"] = "69934" }`;
    const unknown = await post(accessToken, upload(savedVariables(CAPTURED_AT, "Durotar", mismatch)));
    expect(unknown.res.status).toBe(422);
    expect(unknown.body).toEqual(unsupported);

    const rows = await uploadsOf(deviceId);
    expect(rows.map((row) => [row["parse_status"], row["flavor"], row["parse_error"], row["adapter_schema"]])).toEqual([
      ["rejected", "tbc_classic", null, 1],
      ["rejected", "unknown", null, 1],
    ]);
    const snapshots = await pool.query("select 1 from snapshots where upload_id = any($1)", [rows.map((row) => row["id"])]);
    expect(snapshots.rowCount).toBe(0);

    expect(logged.map((line) => JSON.parse(line) as unknown)).toEqual([
      {
        level: "warn",
        time: expect.any(String),
        msg: expect.any(String),
        request_id: expect.any(String),
        route: "/api/v1/ingest",
        user_uuid: user.uuid,
        upload_uuid: rows[1]?.["uuid"],
        kit: "wow",
        reason: "interface 50504 does not match classic_era",
        facts: { project_id: 2, season_id: null, version: null, build: "69934", interface: 50504 },
      },
    ]);

    // Forever is experimental, and experimental flavors have no gate (D8).
    const forever = await post(accessToken, upload(savedVariables(CAPTURED_AT, "Elwynn Forest", `{ ["project_id"] = 1, ["interface"] = 16001 }`)));
    expect(forever.res.status).toBe(201);
    const { rows: stored } = await pool.query("select flavor from snapshots where uuid = $1", [forever.body?.snapshot_uuid]);
    expect(stored[0]).toEqual({ flavor: "forever" });
    expect((await uploadsOf(deviceId)).at(-1)).toMatchObject({ parse_status: "parsed", flavor: null });
  });

  it("answers a body that ends inside the file part, and keeps serving", async () => {
    const { accessToken, deviceId } = await token(await newUser());
    const good = upload(savedVariables(CAPTURED_AT));
    const head = [
      "--X",
      'Content-Disposition: form-data; name="meta"',
      "",
      JSON.stringify(good.meta),
      "--X",
      'Content-Disposition: form-data; name="file"; filename="OpenGamerMCP.lua.gz"',
      "Content-Type: application/octet-stream",
      "",
      "",
    ].join("\r\n");
    // A whole body by its Content-Length, with no closing boundary.
    const res = await fetch(`${base}/api/v1/ingest`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "multipart/form-data; boundary=X" },
      body: Buffer.concat([Buffer.from(head), good.gz.subarray(0, 10)]),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as IngestAnswer).status).toBe("bad_request");
    expect((await post(accessToken, good)).res.status).toBe(201);
    expect(await uploadsOf(deviceId)).toHaveLength(1);
  });

  it("refuses a read token, a device that is revoked or missing, and a device of another user", async () => {
    const user = await newUser();
    const body = upload(savedVariables(CAPTURED_AT));

    const read = await post((await token(user, "read")).accessToken, body);
    expect(read.res.status).toBe(401);
    expect(read.res.headers.get("www-authenticate")).toMatch(/^Bearer error="invalid_token"/);

    // Revoked, but its grant still live: the device's own row refuses it.
    const revoked = await token(user);
    await pool.query("update devices set revoked_at = now() where id = $1", [revoked.deviceId]);
    expect((await post(revoked.accessToken, body)).res.status).toBe(401);

    expect((await post((await token(user, "ingest", null)).accessToken, body)).res.status).toBe(401);
    // A grant of this user's whose device row is another user's.
    expect((await post((await token(user, "ingest", await newUser())).accessToken, body)).res.status).toBe(401);

    const { rows } = await pool.query("select 1 from uploads where user_id = $1", [user.id]);
    expect(rows).toHaveLength(0);
  });

  it("stores each user's upload under their own device and user, whatever the meta says", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const aliceToken = await token(alice);
    const bobToken = await token(bob);
    const same = upload(savedVariables(CAPTURED_AT));

    const fromAlice = await post(aliceToken.accessToken, same);
    // The same bytes of the same instance are not a duplicate for another device.
    const fromBob = await post(bobToken.accessToken, same);
    expect(fromAlice.res.status).toBe(201);
    expect(fromBob.res.status).toBe(201);

    const { rows } = await pool.query<{ uuid: string; user_id: string; device_id: string }>(
      "select s.uuid, s.user_id, u.device_id from snapshots s join uploads u on u.id = s.upload_id and u.user_id = s.user_id where s.uuid = any($1)",
      [[fromAlice.body?.snapshot_uuid, fromBob.body?.snapshot_uuid]],
    );
    expect(rows.find((row) => row.uuid === fromAlice.body?.snapshot_uuid)).toMatchObject({ user_id: alice.id, device_id: aliceToken.deviceId });
    expect(rows.find((row) => row.uuid === fromBob.body?.snapshot_uuid)).toMatchObject({ user_id: bob.id, device_id: bobToken.deviceId });
  });

  it("answers rate_limited with Retry-After over the limit of an instance, and over the limit of the device", async () => {
    const limited = await serve({ ...DEFAULT_INGEST, burst: 1, deviceBurst: 2 });
    const { accessToken, deviceId } = await token(await newUser());
    expect((await post(accessToken, upload(savedVariables(CAPTURED_AT)), limited)).res.status).toBe(201);

    const again = await post(accessToken, upload(savedVariables(CAPTURED_AT, "Westfall")), limited);
    expect(again.res.status).toBe(429);
    expect(again.res.headers.get("retry-after")).toMatch(/^[1-5]$/);
    expect(again.body).toEqual({ status: "rate_limited", message: expect.any(String) });

    // Another account's SavedVariables on the same device has a bucket of its own.
    const other = upload(savedVariables(CAPTURED_AT), { instance: sha256("_classic_era_/WTF/Account/OTHER/SavedVariables/OpenGamerMCP.lua") });
    expect((await post(accessToken, other, limited)).res.status).toBe(201);
    // A new instance each time still meets the device's bucket, which the refused upload took nothing from.
    const third = await post(accessToken, upload(savedVariables(CAPTURED_AT), { instance: sha256("made up") }), limited);
    expect(third.res.status).toBe(429);
    expect(third.body?.status).toBe("rate_limited");
    expect(await uploadsOf(deviceId)).toHaveLength(2);
    // No row for rate_limited: a looping device would grow the table.
    const events = await eventsOf(deviceId, 2);
    expect(events.map((row) => row["status"])).toEqual(["stored", "stored"]);
  });
});
