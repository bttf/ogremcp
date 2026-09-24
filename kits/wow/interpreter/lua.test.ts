import { ParseError } from "@ogmcp/sdk";
import { expect, it } from "vitest";
import { readSavedVariables, type ReadLimits } from "./lua.js";

const LIMITS: ReadLimits = { maxBytes: 1024 * 1024, maxDepth: 32, maxValues: 1000 };

function read(text: string, limits = LIMITS) {
  return Object.fromEntries(readSavedVariables(new TextEncoder().encode(text), limits, "Test.lua"));
}

it("reads the literals of a SavedVariables file as JSON values", () => {
  const text = `
-- A comment.
List = { 1, -2.5, 0x10, 1e3, .5, "a", 'b', [[long]], true, false, }
Object = { ["key"] = "value", name = 1; [3] = "three", [true] = 1 }
Empty = {}
Holes = { "a", nil, "c", dropped = nil }
Gone = nil
--[==[ A long
comment. ]==]
`;
  expect(read(text)).toEqual({
    List: [1, -2.5, 16, 1000, 0.5, "a", "b", "long", true, false],
    Object: { key: "value", name: 1, 3: "three", true: 1 },
    Empty: {},
    Holes: { 1: "a", 3: "c" },
  });
});

it("round-trips UTF-8 and undoes Lua 5.1 escapes", () => {
  const text = String.raw`S = { "Zoëla 你", "Zo\195\171la", "q\"q \\ \n\t\65", "bad \255 byte" }`;
  expect(read(text)["S"]).toEqual(["Zoëla 你", "Zoëla", 'q"q \\ \n\tA', "bad � byte"]);
});

it("keeps a __proto__ key as data", () => {
  const value = read('A = { ["__proto__"] = { x = 1 } }')["A"];
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  expect(Object.keys(value as object)).toEqual(["__proto__"]);
});

it.each([
  "A = os.execute('x')",
  "A = { x = f() }",
  "A = function() end",
  "A = 1 + 2",
  'A = "a" .. "b"',
  "A = { [{}] = 1 }",
  "local A = 1",
])("never evaluates code: %s", (text) => {
  expect(() => read(text)).toThrow(ParseError);
});

it("names the code it found, in a user-facing message", () => {
  expect(() => read("A = {\n x = f() }")).toThrow(
    'Test.lua could not be read: "f" is code, and the server reads only data (line 2). Type /transmit in game to save it again.',
  );
});

it.each(['A = { "x", { 1', 'A = "abc', "A = { 1 --[[ open", "A = { tru"])("rejects truncated input: %s", (text) => {
  expect(() => read(text)).toThrow(/ends in the middle of the data/);
});

it("enforces each limit and accepts input at the limit", () => {
  const limits: ReadLimits = { maxBytes: 64, maxDepth: 3, maxValues: 4 };
  expect(read("A = {{{}}}", limits)).toEqual({ A: [[{}]] });
  expect(() => read("A = {{{{}}}}", limits)).toThrow(/more than 3 levels deep/);
  expect(read("A = {1, 2, 3}", limits)).toEqual({ A: [1, 2, 3] });
  expect(() => read("A = {1, 2, 3, 4}", limits)).toThrow(/more than 4 values/);
  expect(() => read(`A = "${"x".repeat(64)}"`, limits)).toThrow(/larger than 64 bytes/);
});
