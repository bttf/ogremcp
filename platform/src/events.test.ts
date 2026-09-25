import { randomBytes } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPool } from "./db.js";
import { createEventRecorder, createEventsPool, type EventRecorder, listVisits } from "./events.js";
import { parseUpload, writeSnapshot } from "./ingest.js";
import { KIT_SOURCES, type Kit, type KitRegistry } from "./kits/registry.js";
import { checkKits } from "./kits/validate.js";
import { listGames } from "./list-games.js";
import { migrate } from "./migrations.js";
import type { ScopedSearch } from "./search.js";
import { searchGameInfo } from "./search-game-info.js";
import { createToolRegistry, type PlatformTool } from "./tools.js";

// Ingest's events rows: ingest.test.ts.

/** As in migrations.test.ts: a Postgres server whose user may create databases. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"]?.trim() || undefined;
if (TEST_DATABASE_URL === undefined) console.warn("TEST_DATABASE_URL is not set: the Postgres tests in events.test.ts are skipped");

const [checked] = checkKits(KIT_SOURCES);
const WOW: Kit = { key: "wow", name: "World of Warcraft", manifest: checked!.manifest, interpreter: KIT_SOURCES[0]!.interpreter, adapter: null };
const KITS: KitRegistry = { list: () => [WOW], get: (key) => (key === "wow" ? WOW : undefined) };

const CLIENT_ID = "https://agent.example/oauth/client-metadata.json";
const CAPTURED_AT = new Date("2026-09-21T12:00:00Z");

/** A SavedVariables file of a Classic Era character, with synthetic data (§6.3). */
const SAVED_VARIABLES = `OgreMCPDB = {
  ["schema"] = 1,
  ["client"] = { ["project_id"] = 2, ["interface"] = 11509 },
  ["character"] = { ["guid"] = "Player-0000-00000001", ["name"] = "Zoela", ["realm"] = "Testrealm" },
  ["captured_at"] = ${CAPTURED_AT.getTime() / 1000},
  ["state"] = { ["location"] = { ["zone"] = "Elwynn Forest" } },
}
`;

/** A `ScopedSearch` that finds nothing, for 2 credits. */
const search: ScopedSearch = async (_scope, _query, usage) => {
  if (usage !== undefined) usage.searchCredits = 2;
  return [];
};

describe.skipIf(TEST_DATABASE_URL === undefined)("events (§16)", () => {
  const name = `ogremcp_test_${randomBytes(6).toString("hex")}`;
  let admin: Pool;
  let pool: Pool;
  let url: string;
  /** The recorder as `index.ts` makes it: on a pool of its own. */
  let events: EventRecorder;
  let eventsPool: Pool;

  beforeAll(async () => {
    admin = createPool({ url: TEST_DATABASE_URL ?? "", queryTimeoutMs: 10_000, max: 1 });
    await admin.query(`create database "${name}"`);
    const parsed = new URL(TEST_DATABASE_URL ?? "");
    parsed.pathname = `/${name}`;
    url = parsed.toString();
    pool = createPool({ url, queryTimeoutMs: 10_000, max: 4 });
    await migrate(pool);
    eventsPool = createEventsPool({ url });
    events = createEventRecorder({ pool: eventsPool });
  });

  afterAll(async () => {
    await eventsPool?.end();
    await pool?.end();
    try {
      await admin.query(`drop database if exists "${name}" with (force)`);
    } finally {
      await admin.end();
    }
  });

  /** A new user, with WoW enabled or not, and with a snapshot of `SAVED_VARIABLES` or not. */
  async function player({ wow, snapshot }: { wow: boolean; snapshot: boolean }): Promise<{ id: string; uuid: string; deviceId: string }> {
    const { rows: users } = await pool.query<{ id: string; uuid: string }>("insert into users default values returning id, uuid");
    const user = users[0];
    if (user === undefined) throw new Error("no user row");
    if (wow) await pool.query("insert into user_games (user_id, kit) values ($1, 'wow')", [user.id]);
    const { rows: devices } = await pool.query<{ id: string }>("insert into devices (user_id) values ($1) returning id", [user.id]);
    const deviceId = devices[0]?.id ?? "";
    if (snapshot) {
      const parse = parseUpload(WOW, "savedvariables", Buffer.from(SAVED_VARIABLES), CAPTURED_AT);
      if (parse.status !== "parsed") throw new Error("the SavedVariables did not parse");
      const hex = () => randomBytes(32).toString("hex");
      const { rows: uploads } = await pool.query<{ id: string }>(
        `insert into uploads (user_id, device_id, kit, source_id, instance, sha256, content_gzip, kit_version, adapter_schema, parse_status)
         values ($1, $2, 'wow', 'savedvariables', $3, $4, '\\x00', '0.1.0', 1, 'parsed') returning id`,
        [user.id, deviceId, hex(), hex()],
      );
      const client = await pool.connect();
      try {
        await writeSnapshot(client, uploads[0]?.id ?? "", parse.parsed);
      } finally {
        client.release();
      }
    }
    return { ...user, deviceId };
  }

  /** The user's events rows, once there are `count` of them, oldest first. */
  async function eventsOf(userId: string, count: number): Promise<Record<string, unknown>[]> {
    return vi.waitFor(async () => {
      const { rows } = await pool.query<Record<string, unknown>>("select * from events where user_id = $1 order by occurred_at, id", [userId]);
      expect(rows).toHaveLength(count);
      return rows;
    });
  }

  it("writes one row per tool call, with the args summary and no free text but the query", async () => {
    const tools = createToolRegistry({ pool, kits: KITS, search, events });
    const user = await player({ wow: true, snapshot: true });
    const caller = { userUuid: user.uuid, clientId: CLIENT_ID };

    await tools.call(caller, "search_game_info", { game: "wow", query: "  Where is  HOGGER ", flavor: "classic_era" });
    const refused = await tools.call(caller, "wow_get_state", { sections: ["location", "zoela's bags"], flavor: "tbc_classic", character: "Zoela" });
    expect(refused?.isError).toBe(true);
    const state = await tools.call(caller, "wow_get_state", { sections: ["location"], flavor: "classic_era", character: "Zoela" });
    expect(state?.isError).toBeUndefined();
    await tools.call(caller, "list_games", {});

    const rows = await eventsOf(user.id, 4);
    const common = {
      kind: "tool_call",
      agent_client: CLIENT_ID,
      latency_ms: expect.any(Number),
      cache_hit: null,
      device_id: null,
      status: null,
      client_errors: null,
    };
    const age = (row: Record<string, unknown>) => Math.round(((row["occurred_at"] as Date).getTime() - CAPTURED_AT.getTime()) / 1000);
    expect(rows[0]).toMatchObject({
      ...common,
      tool: "search_game_info",
      sections: null,
      flavor: "classic_era",
      query: "where is hogger",
      error: null,
      snapshot_age_seconds: null,
      search_credits: 2,
    });
    // Only the sections the schema names, and only a kit's flavor key.
    expect(rows[1]).toMatchObject({ ...common, tool: "wow_get_state", sections: ["location"], flavor: null, query: null, error: "user_error" });
    expect(rows[1]?.["snapshot_age_seconds"]).toBeNull();
    expect(rows[2]).toMatchObject({ ...common, tool: "wow_get_state", sections: ["location"], flavor: "classic_era", error: null, search_credits: null });
    expect(rows[2]?.["snapshot_age_seconds"]).toBe(age(rows[2]!));
    expect(rows[3]).toMatchObject({ ...common, tool: "list_games", sections: null, flavor: null, error: null });
    expect(rows[3]?.["snapshot_age_seconds"]).toBe(age(rows[3]!));
    expect(JSON.stringify(rows)).not.toMatch(/zoela|tbc/i);
  });

  it("records a failed call's error category, and a failing insert changes no answer", async () => {
    const lines: string[] = [];
    const broken: PlatformTool = {
      name: "break_things",
      description: "",
      inputSchema: { type: "object" },
      handler: async () => {
        throw Object.assign(new Error("duplicate key value: (Zoela)"), { code: "23505" });
      },
    };
    const tools = createToolRegistry({ pool, kits: KITS, platformTools: [listGames, searchGameInfo, broken], log: () => {}, events });
    const user = await player({ wow: false, snapshot: true });
    const caller = { userUuid: user.uuid, clientId: CLIENT_ID };

    await tools.call(caller, "break_things", {});
    await tools.call(caller, "wow_get_state", {});
    await tools.call(caller, "search_game_info", { game: "wow", query: "hogger" });
    await pool.query("insert into user_games (user_id, kit) values ($1, 'wow')", [user.id]);
    await tools.call(caller, "search_game_info", { game: "wow", query: "hogger" });
    const rows = await eventsOf(user.id, 4);
    expect(rows.map((row) => [row["tool"], row["error"]])).toEqual([
      ["break_things", "failed"],
      ["wow_get_state", "game_off"],
      ["search_game_info", "user_error"],
      // No FIRECRAWL_API_KEY.
      ["search_game_info", "search_unavailable"],
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/duplicate key/);

    const down = { query: () => Promise.reject(Object.assign(new Error("terminating connection"), { code: "57P01" })) } as unknown as Pool;
    const failing = createToolRegistry({ pool, kits: KITS, events: createEventRecorder({ pool: down, log: (line) => lines.push(line) }) });
    const expected = await tools.call(caller, "wow_get_state", { sections: ["location"] });
    expect(await failing.call(caller, "wow_get_state", { sections: ["location"] })).toEqual(expected);
    await vi.waitFor(() => expect(lines).toEqual(["event insert failed: kind=tool_call code=57P01"]));
  });

  it("answers tool calls in normal time while the events table is locked, and drops events past the bound", async () => {
    const user = await player({ wow: true, snapshot: true });
    const caller = { userUuid: user.uuid, clientId: CLIENT_ID };
    const lines: string[] = [];
    // A statement timeout longer than the test: the inserts wait on the lock throughout.
    const waitingPool = createEventsPool({ url, statementTimeoutMs: 30_000 });
    const tools = createToolRegistry({ pool, kits: KITS, events: createEventRecorder({ pool: waitingPool, maxPending: 3, log: (line) => lines.push(line) }) });
    const locker = await pool.connect();
    try {
      await locker.query("begin");
      await locker.query("lock table events in access exclusive mode");
      // More calls than the request pool has connections, and than the bound.
      for (let i = 0; i < 8; i++) {
        const started = performance.now();
        expect(await tools.call(caller, "wow_get_state", { sections: ["location"] })).toMatchObject({ structuredContent: { flavor: "classic_era" } });
        expect(performance.now() - started).toBeLessThan(1_000);
      }
      expect(lines).toEqual([]);
      await locker.query("rollback");
      await eventsOf(user.id, 3);
      await vi.waitFor(() => expect(lines).toEqual(["events dropped: count=5"]));
    } finally {
      await locker.query("rollback").catch(() => {});
      locker.release();
      await waitingPool.end();
    }
  });

  it("groups a user's tool calls into visits by gap (§3)", async () => {
    const alice = await player({ wow: false, snapshot: false });
    const bob = await player({ wow: false, snapshot: false });
    const t0 = new Date("2026-01-10T12:00:00Z");
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
    const calls: [typeof alice, number, string, string][] = [
      [alice, 0, "list_games", "claude"],
      [alice, 10, "wow_get_state", "claude"],
      [alice, 35, "search_game_info", "chatgpt"],
      [bob, 5, "wow_get_state", "claude"],
      [alice, 70, "wow_get_state", "claude"],
    ];
    for (const [user, minutes, tool, client] of calls) {
      await pool.query("insert into events (user_id, occurred_at, kind, latency_ms, agent_client, tool) values ($1, $2, 'tool_call', 1, $3, $4)", [
        user.id,
        at(minutes),
        client,
        tool,
      ]);
    }
    // Ingest is not a tool call.
    await pool.query("insert into events (user_id, occurred_at, kind, latency_ms, device_id, status) values ($1, $2, 'ingest', 1, $3, 'stored')", [
      alice.id,
      at(50),
      alice.deviceId,
    ]);

    expect(await listVisits(pool, { since: at(-60), until: at(120), gapMinutes: 30 })).toEqual([
      { userUuid: alice.uuid, startedAt: at(0), endedAt: at(35), calls: 3, tools: ["list_games", "search_game_info", "wow_get_state"], agentClients: ["chatgpt", "claude"] },
      { userUuid: bob.uuid, startedAt: at(5), endedAt: at(5), calls: 1, tools: ["wow_get_state"], agentClients: ["claude"] },
      { userUuid: alice.uuid, startedAt: at(70), endedAt: at(70), calls: 1, tools: ["wow_get_state"], agentClients: ["claude"] },
    ]);
    expect(await listVisits(pool, { since: at(-60), until: at(120), gapMinutes: 40 })).toHaveLength(2);
  });

  it("deletes a user's events with the user", async () => {
    const user = await player({ wow: true, snapshot: true });
    await createToolRegistry({ pool, kits: KITS, search, events }).call({ userUuid: user.uuid, clientId: CLIENT_ID }, "search_game_info", {
      game: "wow",
      query: "hogger",
    });
    await pool.query("insert into events (user_id, occurred_at, kind, latency_ms, device_id, status) values ($1, now(), 'ingest', 1, $2, 'stored')", [
      user.id,
      user.deviceId,
    ]);
    await eventsOf(user.id, 2);
    await pool.query("delete from users where id = $1", [user.id]);
    const { rows } = await pool.query("select 1 from events where user_id = $1", [user.id]);
    expect(rows).toHaveLength(0);
  });
});
