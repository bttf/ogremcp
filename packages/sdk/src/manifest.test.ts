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
    install: "_*_/Interface/AddOns/OgreMCP",
    process: ["Wow*.exe", "World of Warcraft*"],
  },
  sources: [
    {
      id: "savedvariables",
      type: "file",
      format: "text",
      path: "_*_/WTF/Account/*/SavedVariables/OgreMCP.lua",
      trigger: "on_change",
    },
  ],
  flavors: {
    classic_era: {
      status: "supported",
      search: ["https://www.wowhead.com/classic/", "https://warcraft.wiki.gg/"],
      mixed: ["https://warcraft.wiki.gg/"],
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
      { ...example, sources: [{ ...source, path: "{HOME}/WTF/OgreMCP.lua" }] },
    ],
    ["an uppercase tool_prefix", { ...example, tool_prefix: "WoW" }],
    ["a tool_prefix with a dot", { ...example, tool_prefix: "wow.era" }],
    ["an unknown source type", { ...example, sources: [{ ...source, type: "log_tail" }] }],
    ["a kit ID that is not snake_case", { ...example, kit: "../x" }],
    ["a version that is not semver", { ...example, version: "0.1" }],
    ["the reserved flavor key unknown", { ...example, flavors: { unknown: example.flavors.forever } }],
    ...["http://www.wowhead.com/classic/", "https://www.wowhead.com/classic", "https://warcraft.wiki.gg", "https://warcraft.wiki.gg/?x=/"].map(
      (prefix): [string, unknown] => [
        `the search prefix ${prefix}, which is not https or does not end in /`,
        { ...example, flavors: { ...example.flavors, classic_era: { status: "supported", search: [prefix] } } },
      ],
    ),
  ])("rejects %s", (_case, manifest) => {
    expect(validate(manifest)).toBe(false);
  });

  it.each(["/", "\\Games", "C:\\Windows", "../../..", "_*_/../../.ssh/id_ed25519", "_*_\\..\\x"])(
    "rejects the path %s, which leaves root",
    (path) => {
      expect(validate({ ...example, adapter: { ...example.adapter, install: path } })).toBe(false);
    },
  );

  it.each(["Wow?.exe", "Wow[TB].exe", "bin/Wow.exe", "bin\\Wow.exe"])("rejects the process glob %s", (glob) => {
    expect(validate({ ...example, adapter: { ...example.adapter, process: [glob] } })).toBe(false);
  });

  // manifest.ts is generated from the schema, so the two cannot drift.
  it("matches the generated TS types in manifest.ts", async () => {
    const types = await compile(schema as JSONSchema, "Manifest", {
      bannerComment: [
        "// Generated from manifest.schema.json by manifest.test.ts. Do not edit.",
        "// After a schema change, regenerate with: pnpm --filter @ogremcp/sdk test -u",
      ].join("\n"),
      ignoreMinAndMaxItems: true,
    });
    await expect(types).toMatchFileSnapshot("./manifest.ts");
  });
});
