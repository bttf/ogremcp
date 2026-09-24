// The interpreter against the SavedVariables files that the adapter's Lua
// tests write from two stub worlds (test/adapter_test.lua, synthetic data
// only), and against malformed input. RED-293 adds a golden fixture from a
// real client.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ParseError } from "@ogmcp/sdk";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { detect } from "./detect.js";
import { MESSAGE_MAX } from "./errors.js";
import { DEFAULT_LIMITS, interpreter } from "./index.js";

vi.mock("./detect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./detect.js")>();
  return { detect: vi.fn(actual.detect) };
});

const STUB = {
  era: { name: "Zoëla", flavor: "classic_era", project_id: 2, version: "1.15.9", build: "69722", interface: 11509 },
  forever: { name: "Grimble", flavor: "forever", project_id: 1, version: "1.60.1", build: "69893", interface: 16001 },
};

const files = { era: "", forever: "" };

beforeAll(() => {
  const out = mkdtempSync(join(tmpdir(), "ogmcp-interpreter-"));
  try {
    const script = fileURLToPath(new URL("../test/adapter_test.lua", import.meta.url));
    const run = spawnSync("luajit", [script, out], { encoding: "utf8" });
    if (run.error) {
      throw new Error(`These tests run the adapter's Lua tests and need luajit on PATH: ${run.error.message}`);
    }
    expect(run.status, run.stdout + run.stderr).toBe(0);
    files.era = readFileSync(join(out, "era.lua"), "utf8");
    files.forever = readFileSync(join(out, "forever.lua"), "utf8");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

function parse(input: string | Uint8Array) {
  return interpreter.parse("savedvariables", typeof input === "string" ? new TextEncoder().encode(input) : input);
}

describe.each(["era", "forever"] as const)("the %s stub world's file", (client) => {
  it("parses into the §6.2 Parsed shape with the §6.3 sections", () => {
    const text = files[client];
    const { name, flavor, ...facts } = STUB[client];
    const parsed = parse(text);

    expect(parsed).toMatchObject({
      flavor,
      rules: [],
      character: { key: "Player-0000-00000001", name, realm: "Testrealm" },
      capturedAt: new Date(Number(/\["captured_at"\] = (\d+)/.exec(text)?.[1]) * 1000),
      adapterSchema: 1,
    });
    expect(detect).toHaveBeenLastCalledWith({ ...facts, season_id: null });
    expect(parsed).not.toHaveProperty("unknownFlavor");

    const { state } = parsed;
    expect(state.character).toMatchObject({ name, level: 12, xp_max: 7600, in_combat: true, resting: true, dead: false });
    expect(state.location).toMatchObject({ map_id: 1429, x: 0.5, in_instance: false, hearth: "Test Village" });
    expect(state.quests?.partial).toBe(false);
    expect(state.quests?.entries.map((quest) => quest.id)).toEqual([100, 101]);
    // An empty Lua table where a list is expected reads as an empty list.
    expect(state.quests?.entries[1]?.objectives).toEqual([]);
    expect(state.inventory?.equipped[1]?.stats).toEqual({ dps: 5.3, min_damage: 7, max_damage: 11, speed: 1.7 });
    expect(state.skills?.lines.map((line) => line.category)).toEqual(["profession", "weapon", "defense"]);
    expect(Array.isArray(state.recent_path)).toBe(true);
    // Snapshots store the state as jsonb (§11).
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });
});

it.each([0, -1, 9_000_000_000_000, 253_402_300_000])("reads captured_at %d as unknown", (stamp) => {
  const text = files.era.replace(/\["captured_at"\] = \d+/, `["captured_at"] = ${stamp}`);
  expect(parse(text).capturedAt).toBeNull();
});

it("returns an unknown flavor's raw facts for the platform to log (§6.3.1)", () => {
  const parsed = parse(files.era.replace('["interface"] = 11509', '["interface"] = 20506'));
  expect(parsed).toMatchObject({
    flavor: "unknown",
    unknownFlavor: { reason: expect.stringContaining("20506"), facts: { project_id: 2, interface: 20506 } },
  });
});

describe("malformed input is a ParseError", () => {
  const era = () => files.era;
  it.each([
    ["truncated", () => era().slice(0, era().length / 2), /ends in the middle of the data/],
    ["a function call", () => era().replace('"Zoëla"', 'os.execute("x")'), /unexpected "os"/],
    ["a newer schema", () => era().replace('["schema"] = 1,', '["schema"] = 2,'), /saves data format 2/],
    ["an older schema", () => era().replace('["schema"] = 1,', '["schema"] = 0,'), /out of date/],
    ["a wrong type", () => era().replace('["level"] = 12,', '["level"] = "12",'), /at OpenGamerMCPDB\.state\.character\.level:/],
    ["no OpenGamerMCPDB", () => "OtherDB = {}", /holds no Open Gamer MCP data/],
    ["too deep", () => `OpenGamerMCPDB = ${"{".repeat(33)}${"}".repeat(33)}`, /more than 32 levels deep/],
    ["too many values", () => `OpenGamerMCPDB = {${"1,".repeat(200_000)}}`, /more than 200000 values/],
    ["too large", () => new Uint8Array(DEFAULT_LIMITS.maxBytes + 1).fill(0x20), /larger than 5 MB/],
    ["a 1 MB key", () => era().replace('["agility"]', `["${"a".repeat(1_000_000)}"]`), /\.stats\.a{39}…:/],
  ])("%s", (_, input, message) => {
    const error = catchError(() => parse(input()));
    expect(error).toBeInstanceOf(ParseError);
    expect(error.message).toMatch(message);
    expect(error.message.length).toBeLessThanOrEqual(MESSAGE_MAX);
  });
});

function catchError(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected an error");
}
