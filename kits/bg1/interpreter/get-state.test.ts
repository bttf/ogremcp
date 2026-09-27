// bg1_get_state (§10.6) against a fake ToolContext, with the snapshot parsed
// from the chapter 4 fixture.
import { readFileSync } from "node:fs";
import { type Snapshot, type ToolContext, type ToolResult, utf8Length } from "@ogremcp/sdk";
import { expect, it, vi } from "vitest";
import manifest from "../manifest.json" with { type: "json" };
import { EXPERIMENTAL_FLAVORS, FRESHNESS_RULE, QUESTS_RULE, SOURCES_RULE } from "./get-state.js";
import { type Bg1State, interpreter } from "./index.js";
import { SECTIONS } from "./state.js";

const SNAPSHOT_AT = new Date("2026-09-27T12:00:00.000Z");
const parsed = interpreter.parse("gam", readFileSync(new URL("../fixtures/chapter4/BALDUR.gam", import.meta.url)));
const snapshot: Snapshot<Bg1State> = { snapshotAt: SNAPSHOT_AT, flavor: parsed.flavor, rules: parsed.rules, character: parsed.character, state: parsed.state };

const tool = interpreter.tools.find((t) => t.name === "bg1_get_state");

/**
 * The most characters a tool description may have: Claude Code cuts a
 * description at 2,048 (platform/src/instructions.test.ts).
 */
const MAX_DESCRIPTION_CHARS = 2000;

async function call(args: unknown, maxResultBytes: number) {
  if (tool === undefined) throw new Error("The BG1 kit has no bg1_get_state.");
  const ctx = {
    user: { uuid: "00000000-0000-4000-8000-000000000000", tier: "free" },
    maxResultBytes,
    latest: vi.fn(async () => snapshot),
    history: vi.fn(async () => []),
  } satisfies ToolContext<Bg1State>;
  return content(await tool.handler(args, ctx));
}

/** The result's `structuredContent`, after checking the text block holds the same JSON (§10.5). */
function content(result: ToolResult) {
  expect(result.isError).toBeUndefined();
  const text = result.content[0]?.text ?? "";
  expect(JSON.parse(text)).toEqual(result.structuredContent);
  return { bytes: utf8Length(text), data: result.structuredContent as { notes?: string[]; state: Bg1State } };
}

it("is described as §10.5 and §10.6 ask, within the description budget", () => {
  expect(tool?.description).toContain("Baldur's Gate: Enhanced Edition");
  for (const rule of [SOURCES_RULE, FRESHNESS_RULE, QUESTS_RULE]) expect(tool?.description).toContain(rule);
  expect(tool?.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
  const experimental = Object.entries(manifest.flavors).flatMap(([key, { status }]) => (status === "experimental" ? [key] : []));
  expect(EXPERIMENTAL_FLAVORS).toEqual(experimental);
  expect(tool?.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
  expect(tool?.inputSchema.properties?.["sections"]?.["items"]).toEqual({ type: "string", enum: [...SECTIONS] });
});

it("over the cap, leaves out completed quests' entries first, then the oldest text of entries in no quest (§10.6)", async () => {
  const full = await call(undefined, 1024 * 1024);
  expect(full.data.notes).toBeUndefined();
  expect(Object.keys(full.data.state)).toEqual([...SECTIONS]);
  const { quests } = full.data.state;

  // Just under the full size: the completed quests' entries go, their titles stay.
  const first = await call(undefined, full.bytes - 1);
  expect(first.bytes).toBeLessThanOrEqual(full.bytes - 1);
  expect(first.data.state.quests.completed).toEqual(quests.completed.map(({ title }) => ({ title })));
  expect(first.data.state.quests.open).toEqual(quests.open);
  expect(first.data.state.quests.other).toEqual(quests.other);
  expect(first.data.notes).toEqual([
    "To stay under the server's size limit, this result leaves out the entries of completed quests, and keeps their titles. Call bg1_get_state with fewer sections to get the rest.",
  ]);

  // Smaller still: the text of the oldest entries in no quest goes too, as few as fit.
  const cap = first.bytes - 4000;
  const second = await call(undefined, cap);
  expect(second.bytes).toBeLessThanOrEqual(cap);
  const { other } = second.data.state.quests;
  const leftOut = other.findIndex((entry) => entry.text !== undefined);
  expect(leftOut).toBeGreaterThan(0);
  expect(other.slice(0, leftOut).every((entry) => !("text" in entry))).toBe(true);
  expect(other.slice(leftOut)).toEqual(quests.other.slice(leftOut));
  expect(second.data.state.party).toEqual(full.data.state.party);
  expect(second.data.notes).toEqual([
    `To stay under the server's size limit, this result leaves out the entries of completed quests, and keeps their titles. It also leaves out the text of the oldest ${leftOut} of the ${other.length} journal entries that belong to no quest. Call bg1_get_state with fewer sections to get the rest.`,
  ]);
});
