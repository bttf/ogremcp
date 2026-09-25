import { randomBytes } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPool } from "./db.js";
import { createEventRecorder, createEventsPool, type EventRecorder } from "./events.js";
import { parseUpload, writeSnapshot } from "./ingest.js";
import { KIT_SOURCES, type Kit, type KitRegistry } from "./kits/registry.js";
import { checkKits } from "./kits/validate.js";
import { migrate } from "./migrations.js";
import { NOTE_MAX_CHARS, overLimitMessage } from "./report-issue.js";
import type { ScopedSearch } from "./search.js";
import { NOT_ENABLED_MESSAGE } from "./search-game-info.js";
import { DEFAULT_TOOL_CONTEXT } from "./tool-context.js";
import { createToolRegistry } from "./tools.js";

/** As in migrations.test.ts: a Postgres server whose user may create databases. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"]?.trim() || undefined;
if (TEST_DATABASE_URL === undefined) console.warn("TEST_DATABASE_URL is not set: the Postgres tests in report-issue.test.ts are skipped");

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

/** A `ScopedSearch` that finds nothing. */
const search: ScopedSearch = async () => [];

describe.skipIf(TEST_DATABASE_URL === undefined)("report_issue (§16.2)", () => {
  const name = `ogremcp_test_${randomBytes(6).toString("hex")}`;
  let admin: Pool;
  let pool: Pool;
  let eventsPool: Pool;
  let events: EventRecorder;

  beforeAll(async () => {
    admin = createPool({ url: TEST_DATABASE_URL ?? "", queryTimeoutMs: 10_000, max: 1 });
    await admin.query(`create database "${name}"`);
    const parsed = new URL(TEST_DATABASE_URL ?? "");
    parsed.pathname = `/${name}`;
    pool = createPool({ url: parsed.toString(), queryTimeoutMs: 10_000, max: 4 });
    await migrate(pool);
    eventsPool = createEventsPool({ url: parsed.toString() });
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

  /** A new user with WoW enabled or not, a snapshot of `SAVED_VARIABLES`, and its caller. */
  async function player(wow: boolean): Promise<{ id: string; caller: { userUuid: string; clientId: string } }> {
    const { rows: users } = await pool.query<{ id: string; uuid: string }>("insert into users default values returning id, uuid");
    const user = users[0];
    if (user === undefined) throw new Error("no user row");
    if (wow) await pool.query("insert into user_games (user_id, kit) values ($1, 'wow')", [user.id]);
    const { rows: devices } = await pool.query<{ id: string }>("insert into devices (user_id) values ($1) returning id", [user.id]);
    const parse = parseUpload(WOW, "savedvariables", Buffer.from(SAVED_VARIABLES), CAPTURED_AT);
    if (parse.status !== "parsed") throw new Error("the SavedVariables did not parse");
    const hex = () => randomBytes(32).toString("hex");
    const { rows: uploads } = await pool.query<{ id: string }>(
      `insert into uploads (user_id, device_id, kit, source_id, instance, sha256, content_gzip, kit_version, adapter_schema, parse_status)
       values ($1, $2, 'wow', 'savedvariables', $3, $4, '\\x00', '0.1.0', 1, 'parsed') returning id`,
      [user.id, devices[0]?.id, hex(), hex()],
    );
    const client = await pool.connect();
    try {
      await writeSnapshot(client, uploads[0]?.id ?? "", parse.parsed);
    } finally {
      client.release();
    }
    return { id: user.id, caller: { userUuid: user.uuid, clientId: CLIENT_ID } };
  }

  /** Waits until the user has `count` events rows: the recorder writes them without waiting. */
  async function recorded(userId: string, count: number): Promise<void> {
    await vi.waitFor(async () => {
      const { rows } = await pool.query("select 1 from events where user_id = $1", [userId]);
      expect(rows).toHaveLength(count);
    });
  }

  async function issuesOf(userId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await pool.query<Record<string, unknown>>("select * from issues where user_id = $1 order by id", [userId]);
    return rows;
  }

  it("records the note with the current visit's calls and the snapshot the agent read, and no other user's calls", async () => {
    const tools = createToolRegistry({ pool, kits: KITS, search, events });
    const user = await player(true);
    const other = await player(true);
    // A call of an earlier visit: more than 30 minutes before the next one.
    await pool.query("insert into events (user_id, occurred_at, kind, latency_ms, agent_client, tool) values ($1, now() - interval '2 hours', 'tool_call', 1, $2, 'list_games')", [
      user.id,
      CLIENT_ID,
    ]);
    await tools.call(user.caller, "wow_get_state", { sections: ["location"] });
    await tools.call(user.caller, "search_game_info", { game: "wow", query: "Hogger" });
    await tools.call(other.caller, "search_game_info", { game: "wow", query: "someone else's query" });
    await recorded(user.id, 3);
    await recorded(other.id, 1);

    const result = await tools.call(user.caller, "report_issue", { game: "wow", note: "  You sent me the wrong way to Hogger.  " });
    expect(result?.isError).toBeUndefined();
    const [issue, ...more] = await issuesOf(user.id);
    expect(more).toEqual([]);
    expect(result?.structuredContent).toMatchObject({ issue_id: issue?.["uuid"] });

    const { rows: snapshots } = await pool.query<{ uuid: string }>("select uuid from snapshots where user_id = $1", [user.id]);
    expect(issue).toMatchObject({
      kit: "wow",
      note: "You sent me the wrong way to Hogger.",
      agent_client: CLIENT_ID,
      snapshot_uuid: snapshots[0]?.uuid,
      snapshot_at: CAPTURED_AT,
      calls: [
        { tool: "wow_get_state", sections: ["location"], flavor: null, query: null, error: null, occurred_at: expect.any(String) },
        { tool: "search_game_info", sections: null, flavor: null, query: "hogger", error: null, occurred_at: expect.any(String) },
      ],
    });
    expect(JSON.stringify(issue)).not.toContain("someone else");
  });

  it("refuses a game that is not enabled, and an empty, oversized, or NUL note", async () => {
    // A refusal is a user error: nothing reaches the failure log.
    const failures: string[] = [];
    const tools = createToolRegistry({ pool, kits: KITS, events, log: (line) => failures.push(line) });
    const user = await player(false);

    const off = await tools.call(user.caller, "report_issue", { game: "wow", note: "Wrong zone." });
    expect(off).toMatchObject({ isError: true, content: [{ text: NOT_ENABLED_MESSAGE }] });
    await pool.query("insert into user_games (user_id, kit) values ($1, 'wow')", [user.id]);
    for (const note of ["   ", "x".repeat(NOTE_MAX_CHARS + 1), "Wrong\u0000zone.", undefined]) {
      expect(await tools.call(user.caller, "report_issue", { game: "wow", note })).toMatchObject({ isError: true });
    }
    expect(failures).toEqual([]);
    expect(await issuesOf(user.id)).toEqual([]);
  });

  it("records at most REPORT_ISSUE_MAX_PER_DAY reports per user, and deletes them with the user", async () => {
    const tools = createToolRegistry({ pool, kits: KITS, settings: { ...DEFAULT_TOOL_CONTEXT, reportIssueMaxPerDay: 2 } });
    const user = await player(true);
    const report = () => tools.call(user.caller, "report_issue", { game: "wow", note: "Wrong zone." });

    expect((await report())?.isError).toBeUndefined();
    expect((await report())?.isError).toBeUndefined();
    expect(await report()).toMatchObject({ isError: true, content: [{ text: overLimitMessage(2) }] });
    expect(await issuesOf(user.id)).toHaveLength(2);

    await pool.query("delete from users where id = $1", [user.id]);
    expect(await issuesOf(user.id)).toEqual([]);
  });
});
