import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { KIT_SOURCES, type Kit, type KitRegistry } from "./kits/registry.js";
import { UserFacingError } from "./tool-context.js";
import { createToolRegistry, type PlatformTool, TOOL_FAILED_MESSAGE, toolErrorResult } from "./tools.js";

// Listing and calling tools: mcp.test.ts, against a database.

describe("createToolRegistry", () => {
  it("refuses a platform tool named search, and one that shares a kit tool's name (§10.1)", () => {
    const wow = { key: "wow", interpreter: KIT_SOURCES[0]!.interpreter } as Kit;
    const kits: KitRegistry = { list: () => [wow], get: () => wow };
    const tool = (name: string): PlatformTool => ({
      name,
      description: "",
      inputSchema: { type: "object" },
      handler: async () => ({ content: [] }),
    });
    const registry = (...names: string[]) => createToolRegistry({ pool: {} as Pool, kits, platformTools: names.map(tool) });

    expect(() => registry("list_games")).not.toThrow();
    expect(() => registry("search")).toThrow('platform tools: Tool name "search" is reserved');
    expect(() => registry("list_games", "wow_get_state")).toThrow('kit "wow" and the platform tools both have a tool named "wow_get_state"');
  });
});

describe("toolErrorResult", () => {
  it("relays a UserFacingError's message, and logs any other error by its code alone (§10.5)", () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    expect(toolErrorResult(new UserFacingError("None of your characters has that name."), "wow_get_state", log)).toEqual({
      isError: true,
      content: [{ type: "text", text: "None of your characters has that name." }],
    });
    expect(lines).toEqual([]);

    // A Postgres error's message can repeat a row.
    const err = Object.assign(new Error('duplicate key value: (Zoela)'), { code: "23505" });
    expect(toolErrorResult(err, "wow_get_state", log)).toEqual({ isError: true, content: [{ type: "text", text: TOOL_FAILED_MESSAGE }] });
    expect(lines).toEqual(["tool call failed: tool=wow_get_state code=23505"]);
  });
});
