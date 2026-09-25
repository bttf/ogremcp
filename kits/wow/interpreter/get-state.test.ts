// wow_get_state (§10.4) against a fake ToolContext, with snapshots parsed from
// the SavedVariables files that the adapter's Lua tests write from two stub
// worlds (test/adapter_test.lua, synthetic data only).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Snapshot, type ToolContext, type ToolResult, utf8Length } from "@ogremcp/sdk";
import { beforeAll, describe, expect, it, vi } from "vitest";
import manifest from "../manifest.json" with { type: "json" };
import { describeGetState, EXPERIMENTAL_FLAVORS, FOREVER_PATH_NOTE, NO_SNAPSHOT_MESSAGE } from "./get-state.js";
import { interpreter, type WowState } from "./index.js";
import { GEAR_CAVEAT, SECTIONS } from "./sections.js";

const SNAPSHOT_AT = new Date("2026-09-24T12:00:00.000Z");
const snapshots = {} as Record<"era" | "forever", Snapshot<WowState>>;

beforeAll(() => {
  const out = mkdtempSync(join(tmpdir(), "ogremcp-get-state-"));
  try {
    const script = fileURLToPath(new URL("../test/adapter_test.lua", import.meta.url));
    const run = spawnSync("luajit", [script, out], { encoding: "utf8" });
    if (run.error) {
      throw new Error(`These tests run the adapter's Lua tests and need luajit on PATH: ${run.error.message}`);
    }
    expect(run.status, run.stdout + run.stderr).toBe(0);
    for (const client of ["era", "forever"] as const) {
      const parsed = interpreter.parse("savedvariables", readFileSync(join(out, `${client}.lua`)));
      const { flavor, rules, character, state } = parsed;
      snapshots[client] = { snapshotAt: SNAPSHOT_AT, flavor, rules, character, state };
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

const tool = interpreter.tools.find((t) => t.name === "wow_get_state");

/** The platform's default cap (§10.5). */
const MAX_RESULT_BYTES = 40 * 1024;

async function call(args: unknown, latest: Snapshot<WowState> | null, maxResultBytes = MAX_RESULT_BYTES) {
  if (tool === undefined) throw new Error("The WoW kit has no wow_get_state.");
  const ctx = {
    user: { uuid: "00000000-0000-4000-8000-000000000000", tier: "free" },
    maxResultBytes,
    latest: vi.fn(async () => latest),
    history: vi.fn(async () => []),
  } satisfies ToolContext<WowState>;
  return { result: await tool.handler(args, ctx), ctx };
}

/** The result's `structuredContent`, after checking the text block holds the same JSON (§10.5). */
function content(result: ToolResult) {
  expect(result.isError).toBeUndefined();
  expect(result.content).toHaveLength(1);
  expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(result.structuredContent);
  return result.structuredContent as { [key: string]: unknown; state: { [section: string]: unknown } };
}

it("is described as §10.1 and §10.5 ask", () => {
  expect(tool?.description).toContain("World of Warcraft");
  // The rules that act on the result's own fields, and the grounding rule.
  for (const phrase of ["Experimental flavors", "`hardcore`", "`fresh`", "call `search_game_info`", "Never answer from model memory alone", "say so rather than guess"]) {
    expect(tool?.description).toContain(phrase);
  }
  const experimental = Object.entries(manifest.flavors).flatMap(([key, { status }]) => (status === "experimental" ? [key] : []));
  expect(EXPERIMENTAL_FLAVORS).toEqual(experimental);
  expect(describeGetState([])).not.toContain("Experimental");
  expect(tool?.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
  expect(tool?.inputSchema.type).toBe("object");
  expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["sections", "flavor", "character"]);
});

it("by default returns every section of the latest snapshot of any flavor", async () => {
  const { result, ctx } = await call(undefined, snapshots.era);

  expect(ctx.latest).toHaveBeenCalledWith({});
  const data = content(result);
  expect(data).toMatchObject({
    snapshot_at: SNAPSHOT_AT.toISOString(),
    flavor: "classic_era",
    rules: [],
    character: { name: "Zoëla", realm: "Testrealm" },
  });
  expect(data).not.toHaveProperty("notes");
  expect(Object.keys(data.state)).toEqual([...SECTIONS]);
  expect(data.state).toMatchObject({
    character: { level: 12, xp_percent: 39.5, money: { copper: 12345, text: "1g 23s 45c" } },
    location: { zone: "Test Forest", x_percent: 50, y_percent: 61.3, region: "the middle of the zone", facing: "south" },
    quests: { partial: false },
    inventory: {
      gear_incomplete: false,
      equipped: [{ slot: "HeadSlot", quality: "uncommon" }, { slot: "MainHandSlot" }],
      gear: [{ slot: "HeadSlot", comparison: "no_candidates" }, { slot: "MainHandSlot" }],
    },
    skills: { training_due: [] },
    recent_path: [{ captured_at: expect.any(String), zone: "Test Forest", x_percent: 43.1, moved: null }],
  });
});

it("returns only the named sections", async () => {
  const { result } = await call({ sections: ["skills", "quests", "skills"] }, snapshots.era);

  const data = content(result);
  expect(Object.keys(data.state)).toEqual(["quests", "skills"]);
  expect(data).toMatchObject({ snapshot_at: SNAPSHOT_AT.toISOString(), flavor: "classic_era", rules: [], character: { name: "Zoëla" } });
});

it("passes flavor and character to ToolContext", async () => {
  const { ctx } = await call({ flavor: "forever", character: "grimble-testrealm" }, snapshots.forever);

  expect(ctx.latest).toHaveBeenCalledWith({ flavor: "forever", character: "grimble-testrealm" });
});

describe("on a forever snapshot", () => {
  it("notes that recent_path covers only the time since the last reload", async () => {
    const data = content((await call({}, snapshots.forever)).result);

    expect(data).toMatchObject({ flavor: "forever", notes: [FOREVER_PATH_NOTE] });
  });

  it("leaves the note out without recent_path", async () => {
    const data = content((await call({ sections: ["character"] }, snapshots.forever)).result);

    expect(data).not.toHaveProperty("notes");
  });
});

it("returns an isError result with the setup steps when there is no snapshot yet", async () => {
  const { result } = await call({}, null);

  expect(result).toEqual({ isError: true, content: [{ type: "text", text: NO_SNAPSHOT_MESSAGE }] });
  expect(NO_SNAPSHOT_MESSAGE).toMatch(/bridge[\s\S]*approves[\s\S]*\/transmit/);
});

it("rejects an unknown section with a user-facing message", async () => {
  const { result, ctx } = await call({ sections: ["bags"] }, snapshots.era);

  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain('There is no section "bags".');
  expect(ctx.latest).not.toHaveBeenCalled();
});

it("puts the class and proficiency caveat beside better bag items, and lists at most 3", async () => {
  const snapshot = structuredClone(snapshots.era);
  const inventory = snapshot.state.inventory;
  if (inventory === null) throw new Error("The era stub has no inventory.");
  // Four heads with more armor than the equipped one (41).
  for (const armor of [50, 60, 70, 80]) {
    inventory.items.push({
      item_id: 4000 + armor,
      name: "Test Helm",
      count: 1,
      quality: 2,
      item_level: 15,
      min_level: 10,
      equip_loc: "INVTYPE_HEAD",
      type: "Armor",
      sub_type: "Mail",
      sell_price: 400,
      stats: { armor },
    });
  }

  const data = content((await call({ sections: ["inventory"] }, snapshot)).result);
  const gear = (data.state.inventory as { gear: { slot: string; better: { value: number }[] }[] }).gear;
  expect(gear[0]).toMatchObject({ slot: "HeadSlot", comparison: "better_in_bags", caveat: GEAR_CAVEAT, better_total: 4 });
  expect(gear[0]?.better.map((item) => item.value)).toEqual([80, 70, 60]);
  expect(gear[1]).toMatchObject({ slot: "MainHandSlot", better: [] });
  expect(gear[1]).not.toHaveProperty("caveat");
});

it("gives a path time out of a Date's range as null", async () => {
  const snapshot = structuredClone(snapshots.era);
  const [place] = snapshot.state.recent_path ?? [];
  if (place === undefined) throw new Error("The era stub has no recent_path.");
  place.captured_at = Number.MAX_SAFE_INTEGER;

  const data = content((await call({ sections: ["recent_path"] }, snapshot)).result);
  expect(data.state.recent_path).toMatchObject([{ captured_at: null, zone: "Test Forest" }]);
});

describe("over the size cap (§10.5)", () => {
  /** The era snapshot with 20 quests of long descriptions, and `bagItems` bag items. */
  function heavy(bagItems: number): Snapshot<WowState> {
    const snapshot = structuredClone(snapshots.era);
    const { quests, inventory } = snapshot.state;
    if (quests === null || inventory === null) throw new Error("The era stub has no quests or inventory.");
    quests.entries = Array.from({ length: 20 }, (_, i) => ({
      id: 100 + i,
      title: `Test Quest ${i}`,
      level: 10,
      description: "A long quest text. ".repeat(130),
      objectives_text: "Collect 8 Test Pelts.",
      objectives: [{ text: "Test Pelt: 3/8", type: "item", finished: false, num_fulfilled: 3, num_required: 8 }],
      complete: false,
    }));
    for (let i = 0; i < bagItems; i++) {
      inventory.items.push({
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
    return snapshot;
  }

  type Trimmed = { notes?: string[]; state: { quests: { entries: object[] }; inventory: { items: { item_id: number }[]; gear: unknown } } };

  it("leaves out the quest descriptions first, and keeps the bag list when that is enough", async () => {
    const { result } = await call({ sections: ["quests", "inventory"] }, heavy(0));

    const text = result.content[0]?.text ?? "";
    expect(utf8Length(text)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    const data = content(result) as Trimmed;
    expect(data.state.quests.entries).toHaveLength(20);
    expect(data.state.quests.entries[0]).not.toHaveProperty("description");
    expect(data.state.quests.entries[0]).toMatchObject({ objectives_text: "Collect 8 Test Pelts." });
    expect(data.state.inventory.items).toHaveLength(snapshots.era.state.inventory?.items.length ?? -1);
    expect(data.notes).toEqual([
      "To stay under the server's size limit, this result leaves out the quest descriptions. Call wow_get_state with fewer sections to get the rest.",
    ]);
  });

  it("then cuts the bag list to the items that fit, in bag order, and says so", async () => {
    const snapshot = heavy(96);
    const full = content((await call({ sections: ["quests", "inventory"] }, snapshot, 1_000_000)).result) as Trimmed;
    const cap = 16 * 1024;
    const { result } = await call({ sections: ["quests", "inventory"] }, snapshot, cap);

    expect(utf8Length(result.content[0]?.text ?? "")).toBeLessThanOrEqual(cap);
    const data = content(result) as Trimmed;
    const shown = data.state.inventory.items.length;
    const total = full.state.inventory.items.length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(total);
    expect(data.state.inventory.items).toEqual(full.state.inventory.items.slice(0, shown));
    // The gear comparison was made from the whole bag list.
    expect(data.state.inventory.gear).toEqual(full.state.inventory.gear);
    expect(data.state.quests.entries[0]).not.toHaveProperty("description");
    expect(data.notes).toEqual([
      `To stay under the server's size limit, this result leaves out the quest descriptions and lists only the first ${shown} of the ${total} bag items. Call wow_get_state with fewer sections to get the rest.`,
    ]);
  });
});
