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
 *   which a client can still list until a new chat (§10.2). Cap reached,
 *   paid-only, no sources, and search unavailable (§12, §14) will use
 *   `userError` too.
 * - Any other error becomes `TOOL_FAILED_MESSAGE`, and a log line with the
 *   tool's name and the error's code alone: its message can hold user data.
 *
 * An unknown tool name is not a result: `mcp.ts` answers it with the
 * protocol error -32602.
 */

/** What the agent gets when a tool call fails for a reason it cannot act on. */
export const TOOL_FAILED_MESSAGE = "The tool failed on the server. Try again in a moment.";

/** What the agent gets for a kit tool result over the size cap that the kit did not trim to fit. */
export const TOO_LARGE_MESSAGE = "The result is too large to send in one call. Call the tool again with fewer sections.";

/** The fields of every kit tool result (§10.5). */
export const ENVELOPE_FIELDS = ["snapshot_at", "flavor", "rules", "character"] as const;

type Log = (line: string) => void;

/** What a kit tool call answers with its handler's `result`. */
export function kitToolResult(result: ToolResult, tool: string, maxResultBytes: number, log: Log): ToolResult {
  if (result.isError === true) return result;
  const data = result.structuredContent;
  if (data === undefined || ENVELOPE_FIELDS.some((field) => data[field] === undefined)) {
    log(`tool call failed: tool=${tool} code=NO_ENVELOPE_FIELD`);
    return userError(TOOL_FAILED_MESSAGE);
  }
  const text = JSON.stringify(data);
  const bytes = utf8Length(text);
  if (bytes > maxResultBytes) {
    log(`tool result over the size cap: tool=${tool} bytes=${bytes}`);
    return userError(TOO_LARGE_MESSAGE);
  }
  return { content: [{ type: "text", text }], structuredContent: data };
}

/** What a call answers when the handler of `tool` threw `err`. */
export function errorResult(err: unknown, tool: string, log: Log): ToolResult {
  if (err instanceof UserFacingError) return userError(err.message);
  log(`tool call failed: tool=${tool} code=${failureCode(err)}`);
  return userError(TOOL_FAILED_MESSAGE);
}

/** What a call to a tool of the game `gameName` answers when the user has turned the game off. */
export function gameOffResult(gameName: string): ToolResult {
  return userError(`${gameName} is turned off on the Games page of the Open Gamer MCP website. The player can turn it on there.`);
}
