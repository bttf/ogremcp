// Tool results (docs/architecture.md §10.5): the helpers a kit's tools and the
// platform's tools both build their results with.
import type { ToolResult } from "./mcp.js";

/** `data` as `structuredContent` plus the same JSON as a text block (§10.5). */
export function jsonResult(data: { [key: string]: unknown }): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

/**
 * A user-facing condition, such as no snapshot yet or a paid-only tool: an
 * `isError` result with a plain-language message for the agent to relay
 * (§10.5). Not a protocol error.
 */
export function userError(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * The length of `text` in UTF-8 bytes. `ToolContext.maxResultBytes` caps one
 * copy of a result's JSON in this measure.
 */
export function utf8Length(text: string): number {
  let bytes = text.length;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    // 2 bytes up to U+07FF and 3 above. A surrogate pair is 4: 2 per unit.
    if (unit >= 0x80) bytes += unit < 0x800 || (unit >= 0xd800 && unit <= 0xdfff) ? 1 : 2;
  }
  return bytes;
}
