import { Ajv2020 } from "ajv/dist/2020.js";
import { compile, type JSONSchema } from "json-schema-to-typescript";
import { describe, expect, it } from "vitest";
import type { Manifest } from "./manifest.js";
import schema from "./manifest.schema.json" with { type: "json" };

// The example manifest in docs/architecture.md §6.1.
const example = {
  kit: "wow",
  version: "0.1.0",
  sdk: "^0.1.0",
  tool_prefix: "wow",
  root: {
    locate: [
      { path: "{PROGRAM_FILES_X86}/World of Warcraft" },
      { path: "/Applications/World of Warcraft" },
      { prompt: "Select your World of Warcraft folder" },
    ],
    verify: "_*_",
  },
  adapter: {
    install: "_*_/Interface/AddOns/OpenGamerMCP",
    process: ["Wow*.exe", "World of Warcraft*"],
  },
  sources: [
    {
      id: "savedvariables",
      type: "file",
      format: "text",
      path: "_*_/WTF/Account/*/SavedVariables/OpenGamerMCP.lua",
      trigger: "on_change",
    },
  ],
  flavors: {
    classic_era: {
      status: "supported",
      search: ["https://www.wowhead.com/classic/", "https://warcraft.wiki.gg/"],
    },
    forever: { status: "experimental", search: [] },
  },
} satisfies Manifest;

const source = example.sources[0];

const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

describe("manifest schema", () => {
  it("accepts the §6.1 example", () => {
    expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each<[string, unknown]>([
    [
      "a path variable other than {PROGRAM_FILES_X86} and {HOME}",
      { ...example, root: { ...example.root, locate: [{ path: "{APPDATA}/World of Warcraft" }] } },
    ],
    [
      "a variable in a path relative to root",
      { ...example, sources: [{ ...source, path: "{HOME}/WTF/OpenGamerMCP.lua" }] },
    ],
    ["an uppercase tool_prefix", { ...example, tool_prefix: "WoW" }],
    ["a tool_prefix with a dot", { ...example, tool_prefix: "wow.era" }],
    ["an unknown source type", { ...example, sources: [{ ...source, type: "log_tail" }] }],
  ])("rejects %s", (_case, manifest) => {
    expect(validate(manifest)).toBe(false);
  });

  // manifest.ts is generated from the schema, so the two cannot drift.
  it("matches the generated TS types in manifest.ts", async () => {
    const types = await compile(schema as JSONSchema, "Manifest", {
      bannerComment: [
        "// Generated from manifest.schema.json by manifest.test.ts. Do not edit.",
        "// After a schema change, regenerate with: pnpm --filter @ogmcp/sdk test -u",
      ].join("\n"),
      ignoreMinAndMaxItems: true,
    });
    await expect(types).toMatchFileSnapshot("./manifest.ts");
  });
});
