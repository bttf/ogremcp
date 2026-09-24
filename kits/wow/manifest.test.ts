import schema from "@ogmcp/sdk/manifest.schema.json" with { type: "json" };
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import manifest from "./manifest.json" with { type: "json" };

it("validates against the SDK manifest schema (§6.1)", () => {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
});
