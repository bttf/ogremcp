import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { writeAdapterZips, zipAdapter } from "./adapter.js";
import { KIT_SOURCES, loadKitRegistry } from "./registry.js";
import { checkKits, type KitSource } from "./validate.js";

const wow = KIT_SOURCES[0]!;
const wowManifest = wow.manifest as Record<string, unknown>;

/** Reads a zip through its central directory: each entry's name, in order. */
function readZipNames(zip: Buffer): string[] {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const names: string[] = [];
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const nameLength = zip.readUInt16LE(at + 28);
    names.push(zip.subarray(at + 46, at + 46 + nameLength).toString("utf8"));
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return names;
}

describe("loadKitRegistry", () => {
  let adaptersDir: string;
  beforeAll(() => {
    adaptersDir = mkdtempSync(join(tmpdir(), "ogmcp-adapters-"));
    writeAdapterZips(checkKits(KIT_SOURCES), adaptersDir);
  });
  afterAll(() => rmSync(adaptersDir, { recursive: true, force: true }));

  it("loads the WoW kit: manifest, interpreter, and adapter zip (§5, §8.2)", () => {
    const registry = loadKitRegistry({ adaptersDir });
    expect(registry.list().map((kit) => kit.key)).toEqual(["wow"]);
    const kit = registry.get("wow");
    expect(kit?.manifest.tool_prefix).toBe("wow");
    expect(kit?.interpreter).toBe(wow.interpreter);
    expect(registry.get("nope")).toBeUndefined();

    const zip = readFileSync(kit!.adapter!.path);
    expect(kit?.adapter).toMatchObject({
      folder: "OpenGamerMCP",
      sha256: createHash("sha256").update(zip).digest("hex"),
      size: zip.length,
    });
    // A local .DS_Store stays out of the zip.
    const files = readdirSync(wow.adapterDir).filter((file) => !file.startsWith(".")).sort();
    expect(readZipNames(zip)).toEqual(files.map((file) => `OpenGamerMCP/${file}`));
  });

  it("refuses to start with an invalid manifest or tool name", () => {
    const badManifest: KitSource = { ...wow, manifest: { ...wowManifest, tool_prefix: "WoW" } };
    expect(() => loadKitRegistry({ sources: [badManifest], adaptersDir })).toThrow(
      /^@ogmcp\/kit-wow: manifest\.json does not match the SDK manifest schema: manifest\/tool_prefix /,
    );

    const tool = {
      name: "get_state",
      description: "",
      inputSchema: { type: "object" as const },
      handler: async () => ({ content: [] }),
    };
    const badTool: KitSource = { ...wow, interpreter: { ...wow.interpreter, tools: [tool] } };
    expect(() => loadKitRegistry({ sources: [badTool], adaptersDir })).toThrow(
      /^@ogmcp\/kit-wow: Tool name "get_state" must start with "wow_"/,
    );
  });

  it("refuses two kits with the same tool_prefix", () => {
    const other: KitSource = { ...wow, package: "@ogmcp/kit-other", manifest: { ...wowManifest, kit: "other" } };
    expect(() => loadKitRegistry({ sources: [wow, other], adaptersDir })).toThrow(
      '@ogmcp/kit-wow and @ogmcp/kit-other both have tool_prefix "wow"',
    );
  });
});

describe("zipAdapter", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ogmcp-adapter-"));
    mkdirSync(join(dir, "sub"));
    mkdirSync(join(dir, "tests"));
    mkdirSync(join(dir, ".git"));
    for (const file of ["Addon.toc", "B.lua", "a.lua", "sub/C.lua", ".hidden", ".git/config", "tests/t.lua", "x_test.lua", "y.test.ts"]) {
      writeFileSync(join(dir, file), `-- ${file}\n`);
    }
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("holds the shipped files, sorted, under the folder name, and is the same bytes on every build", () => {
    const first = zipAdapter(dir, "Addon");
    expect(readZipNames(first)).toEqual(["Addon/Addon.toc", "Addon/B.lua", "Addon/a.lua", "Addon/sub/C.lua"]);
    expect(first.includes(Buffer.from("-- sub/C.lua\n"))).toBe(true);

    utimesSync(join(dir, "a.lua"), new Date(2001, 0, 1), new Date(2001, 0, 1));
    expect(zipAdapter(dir, "Addon").equals(first)).toBe(true);
  });
});
