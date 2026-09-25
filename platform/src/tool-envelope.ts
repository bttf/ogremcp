import { type ToolResult, userError, utf8Length } from "@ogmcp/sdk";

import { failureCode } from "./db.js";
import { UserFacingError } from "./tool-context.js";

/**
 * The tool response envelope (§10.5): what the tool registry (`tools.ts`)
 * answers a `tools/call` with, once the tool's handler has run or thrown.
 *
 * - A kit tool's result carries `snapshot_at`, `flavor`, `rules`, and
 *   `character`. The kit builds them, because only it knows its result's
 *   shape; the envelope checks them. A result without one is a bug in the
 *   kit: the agent gets `TOOL_FAILED_MESSAGE`, and the log a line with the
 *   code `NO_ENVELOPE_FIELD`.
 * - Its text block is the JSON of its `structuredContent`, made here, so the
 *   two copies are the same whatever the handler put in `content`.
 * - One copy of the JSON is at most `maxResultBytes` (`TOOL_RESULT_MAX_BYTES`,
 *   *proposed*). The kit gets the cap in its `ToolContext` and trims its own
 *   result, because only the kit knows which of its fields matter least. A
 *   result still over the cap becomes `TOO_LARGE_MESSAGE`.
 * - User-facing conditions are `isError` results with a plain-language
 *   message (`userError`), not protocol errors, so the agent relays them: a
 *   `UserFacingError`, such as `ToolContext`'s for an unknown character, and
 *   a call to a tool of a game the user has turned off (`gameOffResult`),
 *   which a client can still list until a new chat (§10.2). So are a free
 *   user's call of a paid-only tool (`paidOnlyResult`, §10.2, §14), cap
 *   reached (`capReachedResult` in `usage.ts`, §14), no sources, and search
 *   unavailable (§12).
 * - Any other error becomes `TOOL_FAILED_MESSAGE`, and a log line with the
 *   tool's name and the error's code alone: its message can hold user data.
 *
 * An unknown tool name is not a result: `mcp.ts` answers it with the
 * protocol error -32602.
 *
 * Each call's answer also names its `ToolCallError`, which the events table
 * records (§16): a category, never the message.
 */

/** What the agent gets when a tool call fails for a reason it cannot act on. */
export const TOOL_FAILED_MESSAGE = "The tool failed on the server. Try again in a moment.";

/** What the agent gets for a kit tool result over the size cap that the kit did not trim to fit. */
export const TOO_LARGE_MESSAGE = "The result is too large to send in one call. Call the tool again with fewer sections.";

/** The fields of every kit tool result (§10.5). */
export const ENVELOPE_FIELDS = ["snapshot_at", "flavor", "rules", "character"] as const;

/**
 * Why a call answered an `isError` result (§16):
 *
 * - `user_error`: a user-facing condition, such as a bad argument or no
 *   snapshot yet.
 * - `game_off`: a tool of a game the user has turned off.
 * - `too_large`: a kit tool result over the size cap.
 * - `no_envelope_field`: a kit tool result without an envelope field.
 * - `failed`: the handler threw an error that is not user-facing.
 * - `no_sources` and `search_unavailable`: search_game_info's and
 *   fetch_game_page's (§12).
 * - `out_of_scope`: fetch_game_page's URL, or the page's final URL, is
 *   outside the game's scopes (§12, §16.1 scope misses).
 * - `not_found`: fetch_game_page's page is a 404.
 * - `cap_reached`: the user's daily tool calls reached the tier's cap, and
 *   the tool did not run (§14, §16.1 cap hits).
 * - `paid_only`: a free user called a paid-only tool, which did not run: an
 *   upgrade prompt (§10.2, §14).
 */
export type ToolCallError =
  | "user_error"
  | "game_off"
  | "too_large"
  | "no_envelope_field"
  | "failed"
  | "no_sources"
  | "search_unavailable"
  | "out_of_scope"
  | "not_found"
  | "cap_reached"
  | "paid_only";

/** What a call answers, and why it is an error, or null when it is not one. */
export interface ToolAnswer {
  result: ToolResult;
  error: ToolCallError | null;
}

type Log = (line: string) => void;

/** What a kit tool call answers with its handler's `result`. */
export function kitToolResult(result: ToolResult, tool: string, maxResultBytes: number, log: Log): ToolAnswer {
  if (result.isError === true) return { result, error: "user_error" };
  const data = result.structuredContent;
  if (data === undefined || ENVELOPE_FIELDS.some((field) => data[field] === undefined)) {
    log(`tool call failed: tool=${tool} code=NO_ENVELOPE_FIELD`);
    return { result: userError(TOOL_FAILED_MESSAGE), error: "no_envelope_field" };
  }
  const text = JSON.stringify(data);
  const bytes = utf8Length(text);
  if (bytes > maxResultBytes) {
    log(`tool result over the size cap: tool=${tool} bytes=${bytes}`);
    return { result: userError(TOO_LARGE_MESSAGE), error: "too_large" };
  }
  return { result: { content: [{ type: "text", text }], structuredContent: data }, error: null };
}

/** What a call answers when the handler of `tool` threw `err`. */
export function errorResult(err: unknown, tool: string, log: Log): ToolAnswer {
  if (err instanceof UserFacingError) return { result: userError(err.message), error: "user_error" };
  log(`tool call failed: tool=${tool} code=${failureCode(err)}`);
  return { result: userError(TOOL_FAILED_MESSAGE), error: "failed" };
}

/** What a call to a tool of the game `gameName` answers when the user has turned the game off. */
export function gameOffResult(gameName: string): ToolResult {
  return userError(`${gameName} is turned off on the Games page of the Open Gamer MCP website. The player can turn it on there.`);
}

/**
 * What a free user's call of a paid-only tool answers (§10.2, §14). It names
 * no price and no billing link: billing is not decided yet (§19.1 D5).
 */
export function paidOnlyResult(): ToolResult {
  return userError(
    "This tool is part of the Open Gamer MCP paid plan, and the player is on the free plan, so it did not run. The Account page of the Open Gamer MCP website will show the plans.",
  );
}
