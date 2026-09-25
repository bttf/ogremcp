import { randomBytes } from "node:crypto";

import type { ToolResult } from "@ogremcp/sdk";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool } from "./db.js";
import { KIT_SOURCES, type Kit, type KitRegistry } from "./kits/registry.js";
import { checkKits } from "./kits/validate.js";
import { migrate } from "./migrations.js";
import { firecrawlScopedSearch, type ScopedSearch, type SearchHit, type SearchScope } from "./search.js";
import { NOT_SET_UP_MESSAGE, searchGameInfo, UNAVAILABLE_MESSAGE } from "./search-game-info.js";
import { DEFAULT_TOOL_CONTEXT } from "./tool-context.js";
import { createToolRegistry } from "./tools.js";

/** As in migrations.test.ts: a Postgres server whose user may create databases. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"]?.trim() || undefined;
if (TEST_DATABASE_URL === undefined) console.warn("TEST_DATABASE_URL is not set: the Postgres tests in search-game-info.test.ts are skipped");

const [checked] = checkKits(KIT_SOURCES);
const WOW: Kit = { key: "wow", name: "World of Warcraft", manifest: checked!.manifest, interpreter: KIT_SOURCES[0]!.interpreter, adapter: null };
const KITS: KitRegistry = { list: () => [WOW], get: (key) => (key === "wow" ? WOW : undefined) };
const USER = { id: "1", uuid: "00000000-0000-4000-8000-000000000001", tier: "free" as const };

const HIT: SearchHit = { title: "Hogger - NPC", url: "https://www.wowhead.com/classic/npc=448/hogger", excerpt: "Found in Elwynn Forest." };

/** A `ScopedSearch` that answers `HIT`, and the calls it got. */
function stubSearch(): { search: ScopedSearch; calls: { scope: SearchScope; query: string }[] } {
  const calls: { scope: SearchScope; query: string }[] = [];
  return {
    calls,
    search: async (scope, query) => {
      calls.push({ scope, query });
      return [HIT];
    },
  };
}

/** Calls the tool with `flavor` given, so that no query reaches the (absent) database. */
function call(args: unknown, search: ScopedSearch | null, games: readonly Kit[] = [WOW]): Promise<ToolResult> {
  return searchGameInfo.handler(args, { pool: {} as Pool, user: USER, agentClient: "agent", games, settings: DEFAULT_TOOL_CONTEXT, search, fetchPage: null, event: {} });
}

describe("search_game_info (§10.3, §12)", () => {
  it("refuses a game the user has not enabled, and an unknown flavor", async () => {
    const { search, calls } = stubSearch();
    const off = await call({ game: "wow", query: "hogger", flavor: "classic_era" }, search, []);
    expect(off.isError).toBe(true);
    expect(off.content[0]?.text).toMatch(/not one of the player's enabled games\. Call list_games/);
    const flavor = await call({ game: "wow", query: "hogger", flavor: "retail" }, search);
    expect(flavor).toEqual({ isError: true, content: [{ type: "text", text: "World of Warcraft has no flavor by that key. Its flavors are: classic_era, forever." }] });
    expect(calls).toEqual([]);
  });

  it("answers no_sources for a flavor with an empty scope, and search_unavailable without a key", async () => {
    const { search, calls } = stubSearch();
    const none = await call({ game: "wow", query: "hogger", flavor: "forever" }, search);
    expect(none).toEqual({ isError: true, content: [{ type: "text", text: expect.stringMatching(/^World of Warcraft \(forever\) has no vetted search sources yet\./) }] });
    expect(calls).toEqual([]);

    const noKey = await call({ game: "wow", query: "hogger", flavor: "classic_era" }, null);
    expect(noKey).toEqual({ isError: true, content: [{ type: "text", text: NOT_SET_UP_MESSAGE }] });
  });

  it("answers search_unavailable when Firecrawl answers 429", async () => {
    const fetch = (async () => new Response("{}", { status: 429 })) as typeof globalThis.fetch;
    const result = await call({ game: "wow", query: "hogger", flavor: "classic_era" }, firecrawlScopedSearch({ apiKey: "test-key", timeoutMs: 5000, fetch }));
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: UNAVAILABLE_MESSAGE }] });
  });

  it("is read-only and open-world (§10.5)", () => {
    expect(searchGameInfo.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
  });
});

describe.skipIf(TEST_DATABASE_URL === undefined)("search_game_info's default flavor", () => {
  const name = `ogremcp_test_${randomBytes(6).toString("hex")}`;
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool({ url: TEST_DATABASE_URL ?? "", queryTimeoutMs: 10_000, max: 1 });
    await admin.query(`create database "${name}"`);
    const url = new URL(TEST_DATABASE_URL ?? "");
    url.pathname = `/${name}`;
    pool = createPool({ url: url.toString(), queryTimeoutMs: 10_000, max: 2 });
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

  /** A new user with WoW enabled and one snapshot per flavor given, oldest first. Answers the user's uuid. */
  async function player(...flavors: string[]): Promise<string> {
    const { rows: users } = await pool.query<{ id: string; uuid: string }>("insert into users default values returning id, uuid");
    const user = users[0];
    if (user === undefined) throw new Error("no user row");
    await pool.query("insert into user_games (user_id, kit) values ($1, 'wow')", [user.id]);
    const { rows: devices } = await pool.query<{ id: string }>("insert into devices (user_id) values ($1) returning id", [user.id]);
    for (const [hour, flavor] of flavors.entries()) {
      const hex = () => randomBytes(32).toString("hex");
      const { rows } = await pool.query<{ id: string }>(
        `insert into uploads (user_id, device_id, kit, source_id, instance, sha256, content_gzip, kit_version, adapter_schema, parse_status)
         values ($1, $2, 'wow', 'savedvariables', $3, $4, '\\x00', '0.1.0', 1, 'parsed') returning id`,
        [user.id, devices[0]?.id, hex(), hex()],
      );
      await pool.query(
        `insert into snapshots (user_id, upload_id, kit, flavor, rules, snapshot_at, state) values ($1, $2, 'wow', $3, '{}', $4, '{}')`,
        [user.id, rows[0]?.id, flavor, new Date(Date.UTC(2026, 8, 24, hour))],
      );
    }
    return user.uuid;
  }

  it("is the active flavor, else the first supported one; flavor overrides it", async () => {
    const { search, calls } = stubSearch();
    const tools = createToolRegistry({ pool, kits: KITS, search });
    const query = { game: "wow", query: "  Where is  HOGGER " };

    // No snapshot yet: the first supported flavor.
    const fresh = await tools.call({ userUuid: await player(), clientId: "test-agent" }, "search_game_info", query);
    expect(fresh?.structuredContent).toEqual({ game: "wow", flavor: "classic_era", status: "supported", results: [HIT] });
    expect(JSON.parse(fresh?.content[0]?.text ?? "")).toEqual(fresh?.structuredContent);
    expect(calls[0]?.query).toBe("where is hogger");
    expect(calls[0]?.scope).toMatchObject({ kit: "wow", flavor: "classic_era", prefixes: ["https://www.wowhead.com/classic/", "https://warcraft.wiki.gg/"] });

    // Played Forever last: its empty scope.
    const forever = { userUuid: await player("classic_era", "forever"), clientId: "test-agent" };
    const none = await tools.call(forever, "search_game_info", query);
    expect(none?.isError).toBe(true);
    expect(none?.content[0]?.text).toMatch(/^World of Warcraft \(forever\) has no vetted search sources yet\./);
    const era = await tools.call(forever, "search_game_info", { ...query, flavor: "classic_era" });
    expect(era?.structuredContent).toMatchObject({ flavor: "classic_era", results: [HIT] });
    expect(calls).toHaveLength(2);
  });
});
