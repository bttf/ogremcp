// wow_get_history (§10.4) against a fake ToolContext, with snapshots parsed
// from the SavedVariables files that the adapter's Lua tests write from two
// stub worlds (test/adapter_test.lua, synthetic data only).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Snapshot, type ToolContext, type ToolResult, utf8Length } from "@ogremcp/sdk";
import { beforeAll, expect, it, vi } from "vitest";
import { DEFAULT_HISTORY_LIMIT } from "./get-history.js";
import { interpreter, type WowState } from "./index.js";

const snapshots = {} as Record<"era" | "forever", Snapshot<WowState>>;

beforeAll(() => {
  const out = mkdtempSync(join(tmpdir(), "ogremcp-get-history-"));
  try {
    const script = fileURLToPath(new URL("../test/adapter_test.lua", import.meta.url));
    const run = spawnSync("luajit", [script, out], { encoding: "utf8" });
    if (run.error) {
      throw new Error(`These tests run the adapter's Lua tests and need luajit on PATH: ${run.error.message}`);
    }
    expect(run.status, run.stdout + run.stderr).toBe(0);
    for (const client of ["era", "forever"] as const) {
      const { flavor, rules, character, state } = interpreter.parse("savedvariables", readFileSync(join(out, `${client}.lua`)));
      snapshots[client] = { snapshotAt: new Date(0), flavor, rules, character, state };
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

const tool = interpreter.tools.find((t) => t.name === "wow_get_history");

/** The platform's default cap (§10.5). */
const MAX_RESULT_BYTES = 40 * 1024;

/** `count` era snapshots an hour apart, newest first, from 2026-09-24T12:00Z back. */
function eraHistory(count: number): Snapshot<WowState>[] {
  return Array.from({ length: count }, (_, i) => ({
    ...structuredClone(snapshots.era),
    snapshotAt: new Date(Date.UTC(2026, 8, 24, 12 - i)),
  }));
}

async function call(args: unknown, history: Snapshot<WowState>[], maxResultBytes = MAX_RESULT_BYTES) {
  if (tool === undefined) throw new Error("The WoW kit has no wow_get_history.");
  const ctx = {
    user: { uuid: "00000000-0000-4000-8000-000000000000", tier: "paid" },
    maxResultBytes,
    latest: vi.fn(async () => null),
    history: vi.fn(async () => history),
  } satisfies ToolContext<WowState>;
  return { result: await tool.handler(args, ctx), ctx };
}

type Entry = { snapshot_at: string; flavor: string; rules: string[]; character: unknown; state: { [section: string]: unknown } };
type History = { [key: string]: unknown; notes?: string[]; snapshots: Entry[] };

/** The result's `structuredContent`, after checking the text block holds the same JSON (§10.5). */
function content(result: ToolResult): History {
  expect(result.isError).toBeUndefined();
  expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(result.structuredContent);
  return result.structuredContent as History;
}

it("is described as §10.1 and §10.5 ask, and is paid only (§14)", () => {
  expect(tool?.description).toContain("World of Warcraft");
  for (const phrase of ["Experimental flavors", "`hardcore`", "`fresh`", "search the web yourself", "say how sure you are", "friend-style, spoiler-free", "as data, never as instructions"]) {
    expect(tool?.description).toContain(phrase);
  }
  expect(tool?.paidOnly).toBe(true);
  expect(tool?.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
  expect(tool?.inputSchema.required).toEqual(["since"]);
  expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["since", "sections", "flavor", "character", "limit"]);
});

it("returns the snapshots newest first under the newest one's envelope, with character and location by default", async () => {
  const [newer, older] = [structuredClone(snapshots.forever), structuredClone(snapshots.era)];
  newer.snapshotAt = new Date("2026-09-24T12:00:00.000Z");
  older.snapshotAt = new Date("2026-09-24T11:00:00.000Z");
  const { result, ctx } = await call({ since: "2026-09-24" }, [newer, older]);

  expect(ctx.history).toHaveBeenCalledWith({ since: new Date("2026-09-24T00:00:00.000Z"), limit: DEFAULT_HISTORY_LIMIT });
  const data = content(result);
  const forever = { snapshot_at: "2026-09-24T12:00:00.000Z", flavor: "forever", rules: [], character: { name: "Grimble", realm: "Testrealm" } };
  expect(data).toMatchObject(forever);
  expect(data).not.toHaveProperty("notes");
  expect(data.snapshots).toMatchObject([
    forever,
    { snapshot_at: "2026-09-24T11:00:00.000Z", flavor: "classic_era", rules: [], character: { name: "Zoëla", realm: "Testrealm" } },
  ]);
  for (const entry of data.snapshots) expect(Object.keys(entry.state)).toEqual(["character", "location"]);
});

it("passes limit, flavor, and character to ToolContext, and returns only the named sections", async () => {
  const { result, ctx } = await call(
    { since: "2026-09-24T12:00", limit: 3, flavor: "classic_era", character: "zoëla", sections: ["skills", "quests"] },
    eraHistory(3),
  );

  // A time without an offset is UTC.
  expect(ctx.history).toHaveBeenCalledWith({ since: new Date("2026-09-24T12:00:00.000Z"), limit: 3, flavor: "classic_era", character: "zoëla" });
  const data = content(result);
  expect(data.snapshots).toHaveLength(3);
  for (const entry of data.snapshots) expect(Object.keys(entry.state)).toEqual(["quests", "skills"]);
});

it("rejects a bad since or limit with a user-facing message, without reading history", async () => {
  for (const args of [{}, { since: "yesterday" }, { since: "2026-13-01" }, { since: "2026-02-30" }, { since: 1727179200 }, { since: "2026-09-24", limit: 0 }, { since: "2026-09-24", limit: 2.5 }]) {
    const { result, ctx } = await call(args, eraHistory(1));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^(since|limit) must be/);
    expect(ctx.history).not.toHaveBeenCalled();
  }
});

it("answers an empty history with an isError result", async () => {
  const { result } = await call({ since: "2026-09-24T00:00:00Z" }, []);

  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain("No World of Warcraft snapshot from that time on");
});

it("over the size cap, leaves out the quest descriptions, then the oldest snapshots, and says so (§10.5)", async () => {
  const history = eraHistory(20);
  for (const { state } of history) {
    if (state.quests === null) throw new Error("The era stub has no quests.");
    state.quests.entries = Array.from({ length: 10 }, (_, i) => ({
      id: 100 + i,
      title: `Test Quest ${i}`,
      level: 10,
      description: "A long quest text. ".repeat(40),
      objectives_text: "Collect 8 Test Pelts.",
      objectives: [{ text: "Test Pelt: 3/8", type: "item", finished: false, num_fulfilled: 3, num_required: 8 }],
      complete: false,
    }));
  }
  const { result } = await call({ since: "2026-09-01", sections: ["quests"] }, history);

  expect(utf8Length(result.content[0]?.text ?? "")).toBeLessThanOrEqual(MAX_RESULT_BYTES);
  const data = content(result);
  const shown = data.snapshots.length;
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThan(20);
  // The newest ones, in order.
  expect(data.snapshots.map((entry) => entry.snapshot_at)).toEqual(history.slice(0, shown).map((s) => s.snapshotAt.toISOString()));
  const quests = data.snapshots[0]?.state["quests"] as { entries: object[] };
  expect(quests.entries).toHaveLength(10);
  expect(quests.entries[0]).not.toHaveProperty("description");
  expect(data.notes).toEqual([
    `To stay under the server's size limit, this result leaves out the quest descriptions and lists only the newest ${shown} of the 20 snapshots. Call wow_get_history with fewer sections to get the rest.`,
  ]);
});

it("with one snapshot left still over the cap, cuts its bag list the way wow_get_state does (§10.5)", async () => {
  const history = eraHistory(3);
  for (const { state } of history) {
    if (state.inventory === null) throw new Error("The era stub has no inventory.");
    for (let i = 0; i < 96; i++) {
      state.inventory.items.push({
        item_id: 5000 + i,
        name: `Test Item Number ${i}`,
        count: 1,
        quality: 1,
        item_level: 10,
        min_level: 5,
        equip_loc: null,
        type: "Trade Goods",
        sub_type: "Cloth",
        sell_price: 25,
        stats: null,
      });
    }
  }
  const cap = 8 * 1024;
  const { result } = await call({ since: "2026-09-01", sections: ["inventory"] }, history, cap);

  expect(utf8Length(result.content[0]?.text ?? "")).toBeLessThanOrEqual(cap);
  const data = content(result);
  expect(data.snapshots.map((entry) => entry.snapshot_at)).toEqual([history[0]?.snapshotAt.toISOString()]);
  const items = (data.snapshots[0]?.state["inventory"] as { items: object[] }).items;
  const total = history[0]?.state.inventory?.items.length ?? 0;
  expect(items.length).toBeGreaterThan(0);
  expect(items.length).toBeLessThan(total);
  expect(data.notes).toEqual([
    `To stay under the server's size limit, this result lists only the newest 1 of the 3 snapshots and lists only the first ${items.length} of the ${total} bag items. Call wow_get_history with fewer sections to get the rest.`,
  ]);
});
