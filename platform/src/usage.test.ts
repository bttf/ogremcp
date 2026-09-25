import { randomBytes } from "node:crypto";

import { userError } from "@ogremcp/sdk";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPool } from "./db.js";
import { createEventRecorder } from "./events.js";
import { migrate } from "./migrations.js";
import type { ToolUser } from "./tool-context.js";
import { createToolRegistry, type PlatformTool } from "./tools.js";
import { createUsageMeter, type ToolCallCaps } from "./usage.js";

/** As in migrations.test.ts: a Postgres server whose user may create databases. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"]?.trim() || undefined;
if (TEST_DATABASE_URL === undefined) console.warn("TEST_DATABASE_URL is not set: the Postgres tests in usage.test.ts are skipped");

describe.skipIf(TEST_DATABASE_URL === undefined)("daily tool-call caps (§14)", () => {
  const name = `ogremcp_test_${randomBytes(6).toString("hex")}`;
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool({ url: TEST_DATABASE_URL ?? "", queryTimeoutMs: 10_000, max: 1 });
    await admin.query(`create database "${name}"`);
    const url = new URL(TEST_DATABASE_URL ?? "");
    url.pathname = `/${name}`;
    pool = createPool({ url: url.toString(), queryTimeoutMs: 10_000, max: 10 });
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

  async function newUser(tier: ToolUser["tier"] = "free"): Promise<ToolUser> {
    const { rows } = await pool.query<ToolUser>("insert into users (tier) values ($1) returning id, uuid, tier", [tier]);
    return rows[0]!;
  }

  async function counts(user: ToolUser): Promise<Record<string, number>> {
    const { rows } = await pool.query<{ day: string; tool_calls: number }>(
      "select to_char(day, 'YYYY-MM-DD') as day, tool_calls from usage_daily where user_id = $1 order by day",
      [user.id],
    );
    return Object.fromEntries(rows.map((row) => [row.day, row.tool_calls]));
  }

  /** A registry with one platform tool, and how many times the tool ran. By default the tool succeeds. */
  function registry(caps: ToolCallCaps, now: Date, handler?: PlatformTool["handler"]) {
    const runs = { count: 0 };
    const tool: PlatformTool = {
      name: "get_answer",
      description: "",
      inputSchema: { type: "object" },
      handler: async (args, ctx) => {
        runs.count += 1;
        return handler?.(args, ctx) ?? { content: [{ type: "text", text: "{}" }], structuredContent: {} };
      },
    };
    const tools = createToolRegistry({
      pool,
      platformTools: [tool],
      events: createEventRecorder({ pool }),
      usage: createUsageMeter({ pool, caps, now: () => now }),
    });
    return { tools, runs };
  }

  it("counts each call per user and UTC day, and with no cap refuses none", async () => {
    let now = new Date("2026-09-25T23:59:59.999Z");
    const meter = createUsageMeter({ pool, now: () => now });
    const [a, b] = [await newUser(), await newUser()];

    for (let i = 0; i < 3; i++) expect((await meter.count(a)).kind).toBe("counted");
    expect((await meter.count(b)).kind).toBe("counted");
    now = new Date("2026-09-26T00:00:00.000Z");
    expect((await meter.count(a)).kind).toBe("counted");

    expect(await counts(a)).toEqual({ "2026-09-25": 3, "2026-09-26": 1 });
    expect(await counts(b)).toEqual({ "2026-09-25": 1 });
  });

  it("at the cap, answers isError with the reset time, does not run or count the call, and records cap_reached", async () => {
    const { tools, runs } = registry({ free: 2, paid: null }, new Date("2026-09-25T13:45:00Z"));
    const user = await newUser();
    const caller = { userUuid: user.uuid, clientId: "test-agent" };

    expect((await tools.call(caller, "get_answer", {}))?.isError).toBeUndefined();
    expect((await tools.call(caller, "get_answer", {}))?.isError).toBeUndefined();
    const capped = await tools.call(caller, "get_answer", {});

    expect(capped).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "The player has used all 2 of today's Ogre MCP tool calls. The count resets at 2026-09-26T00:00:00Z (midnight UTC). Until then, every Ogre MCP tool answers with this message.",
        },
      ],
    });
    expect(runs.count).toBe(2);
    expect(await counts(user)).toEqual({ "2026-09-25": 2 });
    const errors = await vi.waitFor(async () => {
      const { rows } = await pool.query<{ error: string | null }>("select error from events where user_id = $1 order by occurred_at, id", [user.id]);
      expect(rows).toHaveLength(3);
      return rows.map((row) => row.error);
    });
    expect(errors).toEqual([null, null, "cap_reached"]);
  });

  it("applies the paid tier's cap to a paid user", async () => {
    const { tools, runs } = registry({ free: 1, paid: 3 }, new Date("2026-09-25T13:45:00Z"));
    const caller = { userUuid: (await newUser("paid")).uuid, clientId: "test-agent" };

    const results = [];
    for (let i = 0; i < 4; i++) results.push((await tools.call(caller, "get_answer", {}))?.isError ?? false);
    expect(results).toEqual([false, false, false, true]);
    expect(runs.count).toBe(3);
  });

  it("takes back a call that failed through the service's fault, such as search_unavailable", async () => {
    const unavailable: PlatformTool["handler"] = async (_args, ctx) => {
      ctx.event.error = "search_unavailable";
      return userError("Search is unavailable.");
    };
    const { tools, runs } = registry({ free: 1, paid: null }, new Date("2026-09-25T13:45:00Z"), unavailable);
    const user = await newUser();
    const caller = { userUuid: user.uuid, clientId: "test-agent" };

    await tools.call(caller, "get_answer", {});
    await tools.call(caller, "get_answer", {});

    expect(runs.count).toBe(2);
    expect(await counts(user)).toEqual({ "2026-09-25": 0 });
  });

  it("counts a call that failed for the player's reason, such as a bad argument", async () => {
    const { tools, runs } = registry({ free: 1, paid: null }, new Date("2026-09-25T13:45:00Z"), async () => userError("No such character."));
    const user = await newUser();
    const caller = { userUuid: user.uuid, clientId: "test-agent" };

    await tools.call(caller, "get_answer", {});
    const capped = await tools.call(caller, "get_answer", {});

    expect(capped?.content[0]?.text).toMatch(/^The player has used all 1 of today's/);
    expect(runs.count).toBe(1);
    expect(await counts(user)).toEqual({ "2026-09-25": 1 });
  });

  it("lets no burst of concurrent calls past the cap", async () => {
    const meter = createUsageMeter({ pool, caps: { free: 5, paid: null } });
    const user = await newUser();

    const answers = await Promise.all(Array.from({ length: 30 }, () => meter.count(user)));

    expect(answers.filter((answer) => answer.kind === "counted")).toHaveLength(5);
    expect(Object.values(await counts(user))).toEqual([5]);
  });
});
