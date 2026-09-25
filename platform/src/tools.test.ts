import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { KIT_SOURCES, type Kit, type KitRegistry } from "./kits/registry.js";
import { createToolRegistry, type PlatformTool } from "./tools.js";

// Listing and calling tools: mcp.test.ts, against a database. The response
// envelope: tool-envelope.test.ts.

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
