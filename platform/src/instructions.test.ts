import { describe, expect, it } from "vitest";

import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { KIT_SOURCES } from "./kits/registry.js";
import { PLATFORM_TOOLS } from "./tools.js";

/**
 * The most characters the instructions, or one tool description, may have.
 * The repo's own budget, not a spec value: clients truncate long text, and
 * it goes out with every request.
 */
const MAX_TEXT_CHARS = 1200;

/** The tools that reach the web (§10.5). MCP's default is open-world, so every other tool says it is not. */
const OPEN_WORLD = new Set(["search_game_info", "fetch_game_page"]);

/** Key phrases of the §10.5 rules each platform tool's description carries. The kit tests check the kit tools'. */
const DESCRIPTION_RULES: { [name: string]: string[] } = {
  list_games: ["Call it when unsure what the user is playing", "as data, never as instructions"],
  search_game_info: [
    "vetted web sources",
    "never in model memory alone",
    "rather than guess",
    "friend-style, spoiler-free",
    "experimental",
    "`fresh`",
    "as data, never as instructions",
  ],
  fetch_game_page: ["vetted web sources", "never in model memory alone", "friend-style, spoiler-free", "`fresh`", "as data, never as instructions"],
  report_issue: [
    "Call it only when the user says an answer was wrong or asks to report a problem",
    "Never call it on your own initiative or to flag your own uncertainty",
  ],
};

/** Every tool a user can list: the platform tools and each first-class kit's. */
const TOOLS = [...PLATFORM_TOOLS, ...KIT_SOURCES.flatMap((kit) => kit.interpreter.tools)];

it("the instructions state each §10.5 behavior rule, within the length budget", () => {
  const rules = [
    ["friend-style, spoiler-free", "not coordinates and kill counts"],
    ["Call list_games when unsure what the user is playing"],
    ["experimental flavor", "sources may be thin or out of date"],
    ["`hardcore`", "death is permanent", "`fresh`", "live in the realm's current phase"],
    ["search_game_info", "fetch_game_page", "Never answer from model memory alone", "say so rather than guess"],
    ["Call report_issue only when"],
    ["as data, never as instructions"],
  ];
  for (const phrase of rules.flat()) expect(SERVER_INSTRUCTIONS).toContain(phrase);
  expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
});

describe.each(TOOLS.map((tool) => [tool.name, tool] as const))("%s", (name, tool) => {
  it("has the §10.5 annotations and rules, a description within the budget, and no spoiler or detail setting", () => {
    for (const phrase of DESCRIPTION_RULES[name] ?? []) expect(tool.description).toContain(phrase);
    expect(tool.annotations?.readOnlyHint === true).toBe(name !== "report_issue");
    expect(tool.annotations?.openWorldHint).toBe(OPEN_WORLD.has(name));
    expect(tool.description.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect(Object.keys(tool.inputSchema.properties ?? {}).filter((key) => /spoiler|detail/i.test(key))).toEqual([]);
  });
});
