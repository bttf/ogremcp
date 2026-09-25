import { describe, expect, it } from "vitest";
import { checkToolName, ParseError } from "./interpreter.js";

describe("ParseError", () => {
  it("carries the user-facing message", () => {
    const error = new ParseError("Update the OpenGamerMCP addon, then /transmit again.");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ParseError");
    expect(error.message).toBe("Update the OpenGamerMCP addon, then /transmit again.");
    expect(error).not.toHaveProperty("adapterSchema");
    expect(error).not.toHaveProperty("flavor");
  });

  it("carries the facts read before the failure (§16.1)", () => {
    const error = new ParseError("Bad data.", { adapterSchema: 1, flavor: "classic_era" });
    expect(error).toMatchObject({ message: "Bad data.", adapterSchema: 1, flavor: "classic_era" });
  });
});

describe("checkToolName", () => {
  it.each(["wow_get_state", "wow_get_history", `wow_${"a".repeat(60)}`])("accepts %s", (name) => {
    expect(checkToolName(name, "wow")).toBeNull();
  });

  it.each([
    ["no prefix", "get_state"],
    ["another kit's prefix", "bg1_get_state"],
    ["a prefix without its _", "wowget_state"],
    ["only the prefix", "wow_"],
    ["a dot", "wow_get.state"],
    ["uppercase", "wow_Get_State"],
    ["a hyphen", "wow_get-state"],
    ["a doubled _", "wow__get_state"],
    ["65 characters", `wow_${"a".repeat(61)}`],
  ])("rejects %s", (_case, name) => {
    expect(checkToolName(name, "wow")).toEqual(expect.any(String));
  });
});
