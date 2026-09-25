import { type ToolResult, userError } from "@ogmcp/sdk";
import type { Pool } from "pg";

import type { ToolUser } from "./tool-context.js";

/**
 * Daily tool-call caps (§14), on the `usage_daily` table (migration 0010).
 *
 * The tool registry (`tools.ts`) counts each call of a tool the user may call
 * before the tool runs. Every MCP tool counts the same, `list_games` and
 * `report_issue` included, and searches are not counted apart: capping search
 * would cap answers (§12, §14). The count is per user and UTC day.
 *
 * - The cap is the user's tier's (`users.tier`): `TOOL_CALLS_PER_DAY_FREE` or
 *   `TOOL_CALLS_PER_DAY_PAID`. Unset is no cap. §14 says the numbers are
 *   measured, then set, so both start unset, and the calls are counted
 *   whether or not a cap is set.
 * - At the cap, the call does not run, so it costs no search, and it is not
 *   counted. The agent gets `capReachedResult`: an `isError` result that says
 *   when the count resets, at the next midnight UTC (§10.5).
 * - A call that runs is counted whatever it answers, a failure included. The
 *   count is taken before the tool runs, in the statement that checks the
 *   cap, and a failed call can still have spent search credits.
 * - The check and the count are one upsert on the user's row for the day,
 *   which Postgres runs under the row's lock. Concurrent calls of one user
 *   take turns on it, so a burst never passes the cap: the bound is exact.
 * - Lowering a cap during the day refuses the calls past the new cap at once.
 */

/**
 * `TOOL_CALLS_PER_DAY_FREE` and `TOOL_CALLS_PER_DAY_PAID`: the most tool calls
 * a user of each tier makes per UTC day. Null is no cap. `config.ts` reads
 * them from the environment.
 */
export type ToolCallCaps = { readonly [tier in ToolUser["tier"]]: number | null };

/** No cap for either tier, until the numbers are measured and set (§14). */
export const NO_TOOL_CALL_CAPS: ToolCallCaps = { free: null, paid: null };

/** A call refused by the cap. */
export interface CapReached {
  /** The tier's cap. */
  cap: number;
  /** When the count resets: the next midnight UTC. */
  resetAt: Date;
}

export interface UsageMeter {
  /**
   * Counts one tool call of `user` on today's UTC date. Null when the call is
   * counted and may run. When the tier's cap is reached, the call is not
   * counted and must not run. A database error propagates.
   */
  count(user: ToolUser): Promise<CapReached | null>;
}

export interface UsageMeterOptions {
  /** The pool requests use. */
  pool: Pool;
  /** Default: `NO_TOOL_CALL_CAPS`. */
  caps?: ToolCallCaps;
  /** The clock. Default: the system's. */
  now?: () => Date;
}

/**
 * Adds 1 to the user's count for the day, unless the count has reached the
 * cap (`$3`, null for none). No row returned: the cap is reached. A new row
 * starts at 1, within any cap, because a cap is at least 1.
 */
const COUNT_SQL = `
insert into usage_daily as u (user_id, day, tool_calls) values ($1, $2, 1)
on conflict (user_id, day) do update set tool_calls = u.tool_calls + 1
 where $3::integer is null or u.tool_calls < $3::integer
returning tool_calls`;

export function createUsageMeter({ pool, caps = NO_TOOL_CALL_CAPS, now = () => new Date() }: UsageMeterOptions): UsageMeter {
  return {
    async count(user) {
      const at = now();
      const cap = caps[user.tier];
      const { rowCount } = await pool.query(COUNT_SQL, [user.id, at.toISOString().slice(0, 10), cap]);
      if (rowCount === 1 || cap === null) return null;
      return { cap, resetAt: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1)) };
    },
  };
}

/** What a call refused by the cap answers (§10.5, §14). */
export function capReachedResult({ cap, resetAt }: CapReached): ToolResult {
  const reset = resetAt.toISOString().replace(".000Z", "Z");
  return userError(
    `The player has used all ${cap} of today's Open Gamer MCP tool calls. The count resets at ${reset} (midnight UTC). Until then, every Open Gamer MCP tool answers with this message.`,
  );
}
