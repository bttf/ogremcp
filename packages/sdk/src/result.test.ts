import { expect, it } from "vitest";
import { utf8Length } from "./result.js";

it("utf8Length counts UTF-8 bytes, a surrogate pair as 4", () => {
  expect(utf8Length("")).toBe(0);
  expect(utf8Length('{"a":1}')).toBe(7);
  expect(utf8Length("Zoëla")).toBe(6);
  expect(utf8Length("€")).toBe(3);
  expect(utf8Length("😀")).toBe(4);
});
