import { type ToolResult, userError } from "@ogmcp/sdk";
import type { Pool } from "pg";

import { failureCode } from "./db.js";
import { logger } from "./log.js";
import type { ToolUser } from "./tool-context.js";
import type { ToolCallError } from "./tool-envelope.js";

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
 * - A call that fails through the service's fault does not count (owner
 *   decision, 2026-09-25): once it has its answer, `refund` takes it back
 *   from the day it was counted on, never below zero. Those are the
 *   `REFUNDED_ERRORS`. A call that ends in any other error still counts: a
 *   bad argument, no snapshot yet, `no_sources`, a page not found or out of
 *   scope.
 * - The check and the count are one upsert on the user's row for the day,
 *   which Postgres runs under the row's lock. Concurrent calls of one user
 *   take turns on it, so a burst never passes the cap: the bound is exact. A
 *   refund only takes back its own call's count, so the calls that stay
 *   counted never pass the cap either.
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

/**
 * The errors of a call that failed through the service's fault, which
 * `refund` takes back: search is unavailable, the handler threw, or a kit
 * tool's result is over the size cap or lacks an envelope field.
 */
export const REFUNDED_ERRORS: ReadonlySet<ToolCallError> = new Set(["search_unavailable", "failed", "too_large", "no_envelope_field"]);

/** A call `count` counted, and the UTC date it counted on. */
export interface CountedCall {
  kind: "counted";
  /** `users.id`. */
  userId: string;
  /** `YYYY-MM-DD`. */
  day: string;
}

/** A call refused by the cap. It was not counted. */
export interface CapReached {
  kind: "cap_reached";
  /** The tier's cap. */
  cap: number;
  /** When the count resets: the next midnight UTC. */
  resetAt: Date;
}

export interface UsageMeter {
  /**
   * Counts one tool call of `user` on today's UTC date, unless the tier's cap
   * is reached. A refused call is not counted and must not run. A database
   * error propagates.
   */
  count(user: ToolUser): Promise<CountedCall | CapReached>;
  /**
   * Takes a counted call back, never below zero. Never throws: a failed
   * refund is logged by its code, and the call stays counted.
   */
  refund(call: CountedCall): Promise<void>;
}

export interface UsageMeterOptions {
  /** The pool requests use. */
  pool: Pool;
  /** Default: `NO_TOOL_CALL_CAPS`. */
  caps?: ToolCallCaps;
  /** The clock. Default: the system's. */
  now?: () => Date;
  /** Receives one line per failed refund. Default: `logger.error`. */
  log?: (line: string) => void;
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

const REFUND_SQL = "update usage_daily set tool_calls = tool_calls - 1 where user_id = $1 and day = $2 and tool_calls > 0";

export function createUsageMeter({ pool, caps = NO_TOOL_CALL_CAPS, now = () => new Date(), log = logger.error }: UsageMeterOptions): UsageMeter {
  return {
    async count(user) {
      const at = now();
      const day = at.toISOString().slice(0, 10);
      const cap = caps[user.tier];
      const { rowCount } = await pool.query(COUNT_SQL, [user.id, day, cap]);
      if (rowCount === 1 || cap === null) return { kind: "counted", userId: user.id, day };
      return { kind: "cap_reached", cap, resetAt: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1)) };
    },

    async refund({ userId, day }) {
      try {
        await pool.query(REFUND_SQL, [userId, day]);
      } catch (err) {
        log(`tool call refund failed: code=${failureCode(err)}`);
      }
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
