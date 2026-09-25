// wow_get_state (§10.4) against a fake ToolContext, with snapshots parsed from
// the SavedVariables files that the adapter's Lua tests write from two stub
// worlds (test/adapter_test.lua, synthetic data only).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Snapshot, ToolContext, ToolResult } from "@ogmcp/sdk";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { FOREVER_PATH_NOTE, NO_SNAPSHOT_MESSAGE } from "./get-state.js";
import { interpreter, type WowState } from "./index.js";
import { SECTIONS } from "./sections.js";

const SNAPSHOT_AT = new Date("2026-09-24T12:00:00.000Z");
const snapshots = {} as Record<"era" | "forever", Snapshot<WowState>>;

beforeAll(() => {
  const out = mkdtempSync(join(tmpdir(), "ogmcp-get-state-"));
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

async function call(args: unknown, latest: Snapshot<WowState> | null) {
  if (tool === undefined) throw new Error("The WoW kit has no wow_get_state.");
  const ctx = {
    user: { uuid: "00000000-0000-4000-8000-000000000000", tier: "free" },
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
  expect(tool?.annotations).toEqual({ readOnlyHint: true });
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
