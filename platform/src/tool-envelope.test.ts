import { jsonResult, userError } from "@ogmcp/sdk";
import { describe, expect, it } from "vitest";

import { UserFacingError } from "./tool-context.js";
import { errorResult, kitToolResult, TOO_LARGE_MESSAGE, TOOL_FAILED_MESSAGE } from "./tool-envelope.js";

const ENVELOPE = { snapshot_at: "2026-09-21T12:00:00.000Z", flavor: "classic_era", rules: [], character: null };

function logged() {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

describe("kitToolResult (§10.5)", () => {
  it("answers a result without an envelope field with a generic isError result, logged by code", () => {
    const { lines, log } = logged();
    const { character: _, ...withoutCharacter } = ENVELOPE;

    expect(kitToolResult(jsonResult({ ...withoutCharacter, state: {} }), "wow_get_state", 1024, log)).toEqual({
      result: userError(TOOL_FAILED_MESSAGE),
      error: "no_envelope_field",
    });
    expect(lines).toEqual(["tool call failed: tool=wow_get_state code=NO_ENVELOPE_FIELD"]);
  });

  it("sends the structured JSON as the text block, whatever the handler's text", () => {
    const { lines, log } = logged();
    const data = { ...ENVELOPE, state: { location: { zone: "Elwynn Forest" } } };

    const { result, error } = kitToolResult({ content: [{ type: "text", text: "something else" }], structuredContent: data }, "wow_get_state", 1024, log);
    expect(error).toBeNull();
    expect(result).toEqual({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(result.structuredContent);
    expect(lines).toEqual([]);
  });

  it("answers a result over the cap with a user-facing isError result", () => {
    const { lines, log } = logged();
    const data = { ...ENVELOPE, state: { pad: "x".repeat(1000) } };

    expect(kitToolResult(jsonResult(data), "wow_get_state", 1000, log)).toEqual({ result: userError(TOO_LARGE_MESSAGE), error: "too_large" });
    expect(lines).toEqual([`tool result over the size cap: tool=wow_get_state bytes=${JSON.stringify(data).length}`]);
  });
});

describe("errorResult", () => {
  it("relays a UserFacingError's message, and logs any other error by its code alone", () => {
    const { lines, log } = logged();
    expect(errorResult(new UserFacingError("None of your characters has that name."), "wow_get_state", log)).toEqual({
      result: { isError: true, content: [{ type: "text", text: "None of your characters has that name." }] },
      error: "user_error",
    });
    expect(lines).toEqual([]);

    // A Postgres error's message can repeat a row.
    const err = Object.assign(new Error("duplicate key value: (Zoela)"), { code: "23505" });
    expect(errorResult(err, "wow_get_state", log)).toEqual({ result: { isError: true, content: [{ type: "text", text: TOOL_FAILED_MESSAGE }] }, error: "failed" });
    expect(lines).toEqual(["tool call failed: tool=wow_get_state code=23505"]);
  });
});
