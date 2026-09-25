import { randomBytes } from "node:crypto";

import { jsonResult, type ToolDef } from "@ogremcp/sdk";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPool } from "./db.js";
import { createEventRecorder } from "./events.js";
import { KIT_SOURCES, type Kit, type KitRegistry } from "./kits/registry.js";
import { migrate } from "./migrations.js";
import type { ToolUser } from "./tool-context.js";
import { createToolRegistry, type PlatformTool } from "./tools.js";

// Listing and calling tools over MCP: mcp.test.ts, against a database. The
// response envelope: tool-envelope.test.ts. The daily caps: usage.test.ts.

/** As in migrations.test.ts: a Postgres server whose user may create databases. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"]?.trim() || undefined;
if (TEST_DATABASE_URL === undefined) console.warn("TEST_DATABASE_URL is not set: the Postgres tests in tools.test.ts are skipped");

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

describe.skipIf(TEST_DATABASE_URL === undefined)("paid-only tools (§10.2, §14)", () => {
  const name = `ogremcp_test_${randomBytes(6).toString("hex")}`;
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool({ url: TEST_DATABASE_URL ?? "", queryTimeoutMs: 10_000, max: 1 });
    await admin.query(`create database "${name}"`);
    const url = new URL(TEST_DATABASE_URL ?? "");
    url.pathname = `/${name}`;
    pool = createPool({ url: url.toString(), queryTimeoutMs: 10_000, max: 4 });
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

  it("lists them for every tier, refuses a free user's call with the upgrade message, and runs a paid user's", async () => {
    const runs: string[] = [];
    const kitTool: ToolDef<unknown> = {
      name: "wow_get_extra",
      description: "",
      inputSchema: { type: "object" },
      paidOnly: true,
      handler: async () => {
        runs.push("wow_get_extra");
        return jsonResult({ snapshot_at: "2026-09-25T12:00:00.000Z", flavor: "classic_era", rules: [], character: null });
      },
    };
    const platformTool: PlatformTool = {
      name: "get_extra",
      description: "",
      inputSchema: { type: "object" },
      paidOnly: true,
      handler: async () => {
        runs.push("get_extra");
        return jsonResult({});
      },
    };
    const wow = { key: "wow", name: "World of Warcraft", manifest: { flavors: {} }, interpreter: { tools: [kitTool] } } as unknown as Kit;
    const tools = createToolRegistry({
      pool,
      kits: { list: () => [wow], get: () => wow },
      platformTools: [platformTool],
      events: createEventRecorder({ pool }),
    });
    const newUser = async (tier: ToolUser["tier"]): Promise<ToolUser> => {
      const { rows } = await pool.query<ToolUser>("insert into users (tier) values ($1) returning id, uuid, tier", [tier]);
      await pool.query("insert into user_games (user_id, kit) values ($1, 'wow')", [rows[0]!.id]);
      return rows[0]!;
    };
    const [free, paid] = [await newUser("free"), await newUser("paid")];

    for (const user of [free, paid]) {
      expect((await tools.list(user.uuid)).map((tool) => tool.name)).toEqual(["get_extra", "wow_get_extra"]);
    }

    for (const tool of ["get_extra", "wow_get_extra"]) {
      expect(await tools.call({ userUuid: free.uuid, clientId: "test-agent" }, tool, {})).toEqual({
        isError: true,
        content: [
          {
            type: "text",
            text: "This tool is part of the Ogre MCP paid plan, and the player is on the free plan, so it did not run. The Account page of the Ogre MCP website will show the plans.",
          },
        ],
      });
    }
    expect(runs).toEqual([]);

    for (const tool of ["get_extra", "wow_get_extra"]) {
      expect((await tools.call({ userUuid: paid.uuid, clientId: "test-agent" }, tool, {}))?.isError).toBeUndefined();
    }
    expect(runs).toEqual(["get_extra", "wow_get_extra"]);

    // The refusals are recorded, and not counted toward the daily cap.
    await vi.waitFor(async () => {
      const { rows } = await pool.query("select user_id, tool, error from events order by user_id, tool");
      expect(rows).toEqual([
        { user_id: free.id, tool: "get_extra", error: "paid_only" },
        { user_id: free.id, tool: "wow_get_extra", error: "paid_only" },
        { user_id: paid.id, tool: "get_extra", error: null },
        { user_id: paid.id, tool: "wow_get_extra", error: null },
      ]);
    });
    const { rows: usage } = await pool.query("select user_id, tool_calls from usage_daily order by user_id");
    expect(usage).toEqual([{ user_id: paid.id, tool_calls: 2 }]);
  });
});
