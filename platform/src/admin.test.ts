import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type AdminMetrics, createAdminPool } from "./admin.js";
import { createApp } from "./app.js";
import { createPool } from "./db.js";
import { migrate } from "./migrations.js";
import { WebSessions } from "./web-sessions.js";

/** As in migrations.test.ts: a Postgres server whose user may create databases. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"]?.trim() || undefined;
if (TEST_DATABASE_URL === undefined) console.warn("TEST_DATABASE_URL is not set: the Postgres tests in admin.test.ts are skipped");

const ISSUER = "http://localhost:4790";
const DAY_MS = 24 * 60 * 60 * 1000;
const CIMD_CLIENT = "https://agent.example/oauth/client-metadata.json";
const DCR_CLIENT = "dcr-client-0123456789";
const LONG_QUERY = `where is ${"the ".repeat(40)}trainer`;

describe.skipIf(TEST_DATABASE_URL === undefined)("the Admin API against Postgres (§13.2, §16.1)", () => {
  const name = `ogremcp_test_${randomBytes(6).toString("hex")}`;
  const now = Date.now();
  /** An instant `minutes` from now. */
  const at = (minutes: number) => new Date(now + minutes * 60_000);
  let admin: Pool;
  let pool: Pool;
  let adminPool: Pool;
  let server: Server | undefined;
  let base: string;
  /** Every uuid of a row the seed made: none may appear in an answer. */
  const ids: string[] = [DCR_CLIENT];
  let adminCookie: string;
  let playerCookie: string;

  /** Inserts one events row of `fields`. */
  async function event(fields: Record<string, unknown>): Promise<void> {
    const columns = Object.keys(fields);
    await pool.query(
      `insert into events (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(fields),
    );
  }

  beforeAll(async () => {
    admin = createPool({ url: TEST_DATABASE_URL ?? "", queryTimeoutMs: 10_000, max: 1 });
    await admin.query(`create database "${name}"`);
    const url = new URL(TEST_DATABASE_URL ?? "");
    url.pathname = `/${name}`;
    pool = createPool({ url: url.toString(), queryTimeoutMs: 10_000, max: 4 });
    await migrate(pool);
    adminPool = createAdminPool({ url: url.toString() });

    const sessions = new WebSessions({ pool, lifetimeMs: 30 * DAY_MS, renewWithinMs: 15 * DAY_MS, secure: false });
    const { rows: users } = await pool.query<{ id: string; uuid: string }>("insert into users (tier) values ('free'), ('free') returning id, uuid");
    const [owner, player] = users;
    if (owner === undefined || player === undefined) throw new Error("no user rows");
    ids.push(owner.uuid, player.uuid);
    adminCookie = `ogremcp_session=${(await sessions.create(owner.id)).token}`;
    playerCookie = `ogremcp_session=${(await sessions.create(player.id)).token}`;

    const { rows: devices } = await pool.query<{ id: string; uuid: string }>(
      "insert into devices (user_id, name) values ($1, 'Test bridge') returning id, uuid",
      [player.id],
    );
    const device = devices[0];
    if (device === undefined) throw new Error("no device row");
    ids.push(device.uuid);
    // An agent client, as dynamic registration stores one.
    await pool.query("insert into oidc_models (model, oidc_id, payload) values ('Client', $1, $2)", [
      DCR_CLIENT,
      { client_id: DCR_CLIENT, client_name: "Test agent" },
    ]);

    // Ingest: a stored upload, a duplicate, a failed parse before and after its schema and flavor were read, and a
    // rejected flavor, and one before the window.
    const ingest = { user_id: player.id, device_id: device.id, kind: "ingest", latency_ms: 5, kit: "wow", kit_version: "0.1.0" };
    const client = { bridge_version: "0.1.0", os: "windows" };
    await event({ ...ingest, ...client, occurred_at: at(-300), status: "stored", parse_status: "parsed", adapter_schema: 1, flavor: "classic_era", client_errors: { upload_failed: 2 } });
    await event({ ...ingest, ...client, occurred_at: at(-290), status: "duplicate", client_errors: { upload_failed: 5 } });
    await event({ ...ingest, ...client, occurred_at: at(-280), status: "parse_error", parse_status: "failed", client_errors: { locate_failed: 1 } });
    await event({ ...ingest, ...client, occurred_at: at(-275), status: "parse_error", parse_status: "failed", adapter_schema: 1, flavor: "classic_era" });
    await event({ ...ingest, ...client, occurred_at: at(-270), status: "unsupported_flavor", parse_status: "rejected", adapter_schema: 1, flavor: "tbc_classic" });
    await event({ ...ingest, occurred_at: at(-10 * 24 * 60), status: "stored", parse_status: "parsed", bridge_version: "0.0.9", os: "darwin" });

    // A visit of the CIMD agent that read state and searched.
    const snapshotUuid = randomUUID();
    ids.push(snapshotUuid);
    const call = { user_id: player.id, kind: "tool_call", latency_ms: 50 };
    const cimd = { ...call, agent_client: CIMD_CLIENT };
    await event({ ...cimd, occurred_at: at(-180), tool: "wow_get_state", sections: ["quests", "location"], snapshot_age_seconds: 100, snapshot_uuid: snapshotUuid });
    await event({ ...cimd, occurred_at: at(-179), tool: "search_game_info", query: "mage trainer", cache_hit: false, search_credits: 2 });
    await event({ ...cimd, occurred_at: at(-178), tool: "search_game_info", query: "mage trainer", cache_hit: true });
    await event({ ...cimd, occurred_at: at(-177), tool: "search_game_info", query: LONG_QUERY, cache_hit: false, search_credits: 2 });
    await event({ ...cimd, occurred_at: at(-176), tool: "fetch_game_page", error: "out_of_scope" });
    // A visit of the DCR agent that read state, whose one search failed, and that reached the cap.
    const dcr = { ...call, agent_client: DCR_CLIENT };
    await event({ ...dcr, occurred_at: at(-60), tool: "wow_get_state", snapshot_age_seconds: 200 });
    await event({ ...dcr, occurred_at: at(-59), tool: "list_games", error: "cap_reached" });
    await event({ ...dcr, occurred_at: at(-58), tool: "search_game_info", query: "mage trainer", error: "search_unavailable" });
    // Another user's visit of the CIMD agent, whose one kit tool call failed: it read no state.
    await event({ ...cimd, user_id: owner.id, occurred_at: at(-30), tool: "wow_get_state", error: "game_off" });

    await pool.query(
      "insert into issues (user_id, created_at, kit, note, agent_client, calls, snapshot_uuid, snapshot_at) values ($1, $2, 'wow', $3, $4, '[]', $5, $2)",
      [player.id, at(-58), "The trainer was not where it said.", DCR_CLIENT, snapshotUuid],
    );

    const app = createApp({
      health: { checkDatabase: () => Promise.resolve() },
      auth: { pool, sessions, providers: { google: null, discord: null }, publicBaseUrl: ISSUER, log: () => {} },
      admin: { pool: adminPool, adminUserUuids: [owner.uuid] },
    });
    server = createServer(app).listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.close();
    await adminPool?.end();
    await pool?.end();
    try {
      await admin.query(`drop database if exists "${name}" with (force)`);
    } finally {
      await admin.end();
    }
  });

  function get(path: string, cookie?: string): Promise<Response> {
    return fetch(`${base}${path}`, { headers: { Accept: "application/json", ...(cookie !== undefined && { Cookie: cookie }) } });
  }

  it("answers anyone but an admin as it answers a path that does not exist", async () => {
    const missing = await get("/api/v1/nope", playerCookie);
    for (const cookie of [playerCookie, undefined]) {
      const res = await get("/api/v1/admin/metrics", cookie);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual(await missing.clone().json());
    }
  });

  it("answers an admin each metric of the window, and no row's uuid", async () => {
    expect((await get("/api/v1/admin/metrics?days=0", adminCookie)).status).toBe(400);
    expect((await get("/api/v1/admin/metrics?days=seven", adminCookie)).status).toBe(400);

    const res = await get("/api/v1/admin/metrics", adminCookie);
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const id of ids) expect(text).not.toContain(id);
    const metrics = JSON.parse(text) as AdminMetrics;

    expect(metrics.window.days).toBe(7);
    expect(metrics.bridges).toEqual([
      { bridge_version: "0.1.0", os: "windows", devices: 1, requests: 5, errors: { upload_failed: 2, locate_failed: 1 } },
    ]);
    const parse = { kit: "wow", kit_version: "0.1.0" };
    expect(metrics.parses).toEqual([
      { ...parse, version_total: true, adapter_schema: null, flavor: null, uploads: 4, failed: 2 },
      { ...parse, version_total: false, adapter_schema: null, flavor: null, uploads: 1, failed: 1 },
      { ...parse, version_total: false, adapter_schema: 1, flavor: "classic_era", uploads: 2, failed: 1 },
      { ...parse, version_total: false, adapter_schema: 1, flavor: "tbc_classic", uploads: 1, failed: 0 },
    ]);
    expect(metrics.unsupported_flavors).toEqual([{ kit: "wow", flavor: "tbc_classic", rejections: 1, users: 1 }]);
    expect(metrics.snapshot_age).toEqual([
      { tool: "wow_get_state", reads: 2, p50: expect.closeTo(150), p90: expect.closeTo(190), p99: expect.closeTo(199) },
    ]);
    expect(metrics.tools).toEqual([
      { tool: "fetch_game_page", calls: 1, errors: 1, with_sections: 0 },
      { tool: "list_games", calls: 1, errors: 1, with_sections: 0 },
      { tool: "search_game_info", calls: 4, errors: 1, with_sections: 0 },
      { tool: "wow_get_state", calls: 3, errors: 1, with_sections: 1 },
    ]);
    expect(metrics.sections).toEqual([
      { tool: "wow_get_state", section: "location", calls: 1 },
      { tool: "wow_get_state", section: "quests", calls: 1 },
    ]);
    expect([...metrics.grounding].sort((a, b) => a.agent_client.localeCompare(b.agent_client))).toEqual([
      { agent_client: "DCR: Test agent", visits: 1, read_state: 1, read_state_no_search: 1 },
      { agent_client: CIMD_CLIENT, visits: 2, read_state: 1, read_state_no_search: 0 },
    ]);
    expect(metrics.search).toEqual({
      active_users: 2,
      lookups: 3,
      hits: 1,
      credits: 4,
      scope_misses: 1,
      tools: [
        { tool: "fetch_game_page", lookups: 0, hits: 0, credits: 0, scope_misses: 1 },
        { tool: "search_game_info", lookups: 3, hits: 1, credits: 4, scope_misses: 0 },
      ],
    });
    expect([...metrics.uncached_queries].sort((a, b) => a.query.localeCompare(b.query))).toEqual([
      { query: "mage trainer", searches: 1, users: 1 },
      { query: LONG_QUERY.slice(0, 120), searches: 1, users: 1 },
    ]);
    expect(metrics.issues).toEqual({
      total: 1,
      notes: [{ created_at: at(-58).toISOString(), kit: "wow", agent_client: "DCR: Test agent", note: "The trainer was not where it said." }],
    });
    expect(metrics.cap_hits).toEqual([{ day: at(-59).toISOString().slice(0, 10), tier: "free", hits: 1, users: 1 }]);
    expect(metrics.storage.database_bytes).toBeGreaterThan(0);
    expect(metrics.storage.tables.map((table) => table.table)).toEqual(expect.arrayContaining(["events", "uploads", "snapshots", "issues"]));
    for (const table of metrics.storage.tables) expect(table).toEqual({ table: table.table, bytes: expect.any(Number), rows: expect.any(Number) });

    // A window of 30 days also holds the upload of 10 days back.
    const month = (await (await get("/api/v1/admin/metrics?days=30", adminCookie)).json()) as AdminMetrics;
    expect(month.window.days).toBe(30);
    expect(month.bridges.map((row) => row.bridge_version)).toEqual(["0.1.0", "0.0.9"]);
  });
});
