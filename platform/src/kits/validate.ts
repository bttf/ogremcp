// The checks a kit passes before the platform uses it (docs/architecture.md
// §5, §6.1, §10.1, §10.2). The platform runs them at startup and at build
// time, so a bad kit fails the build and the deploy, not a request.
import type { Interpreter, Manifest } from "@ogremcp/sdk";
import schema from "@ogremcp/sdk/manifest.schema.json" with { type: "json" };
import { Ajv2020 } from "ajv/dist/2020.js";

import { checkKitToolName, MAX_KIT_TOOLS } from "../tool-names.js";

/** A first-class kit as the registry lists it, before it is checked. */
export interface KitSource {
  /** The kit's package name, for messages. */
  package: string;
  /** The kit's `manifest.json`, checked against the SDK's manifest schema. */
  manifest: unknown;
  interpreter: Interpreter<unknown>;
  /** The kit's `adapter/` folder. The build zips it (§5, §8.2). */
  adapterDir: string;
}

/** A kit that passed every check. */
export interface CheckedKit {
  source: KitSource;
  manifest: Manifest;
  /**
   * The folder the adapter zip holds: the last segment of `adapter.install`,
   * e.g. `OgreMCP`. Null for an adapter-less kit.
   */
  adapterFolder: string | null;
}

const ajv = new Ajv2020({ strict: true });
const validateManifest = ajv.compile<Manifest>(schema);

/** A glob character, which a folder name may not hold. */
const GLOB = /[*?[\]]/;

/**
 * Checks every kit: its manifest against the SDK schema, its kit key and
 * `tool_prefix` against every other kit's, each flavor's `mixed` prefixes
 * against its `search` prefixes (§6.1), its tool count against
 * `MAX_KIT_TOOLS` (§10.2), and each tool's full name with `checkKitToolName`
 * and against every other kit tool's (§10.1). Throws on the first problem,
 * naming the kit.
 */
export function checkKits(sources: readonly KitSource[]): CheckedKit[] {
  const kits: CheckedKit[] = [];
  const byKey = new Map<string, string>();
  const byPrefix = new Map<string, string>();
  const byTool = new Map<string, string>();
  for (const source of sources) {
    if (!validateManifest(source.manifest)) {
      throw new Error(
        `${source.package}: manifest.json does not match the SDK manifest schema: ${ajv.errorsText(validateManifest.errors, { dataVar: "manifest" })}`,
      );
    }
    const manifest = source.manifest;

    const sameKey = byKey.get(manifest.kit);
    if (sameKey !== undefined) {
      throw new Error(`${sameKey} and ${source.package} both have kit "${manifest.kit}". Each kit needs its own.`);
    }
    byKey.set(manifest.kit, source.package);
    const samePrefix = byPrefix.get(manifest.tool_prefix);
    if (samePrefix !== undefined) {
      throw new Error(
        `${samePrefix} and ${source.package} both have tool_prefix "${manifest.tool_prefix}". Each kit needs its own (§6.1).`,
      );
    }
    byPrefix.set(manifest.tool_prefix, source.package);

    for (const [flavor, config] of Object.entries(manifest.flavors)) {
      const stray = config.mixed?.find((prefix) => !config.search.includes(prefix));
      if (stray !== undefined) {
        throw new Error(`${source.package}: flavors.${flavor}.mixed has "${stray}", which is not in flavors.${flavor}.search (§6.1).`);
      }
    }

    const tools = source.interpreter.tools;
    if (tools.length > MAX_KIT_TOOLS) {
      throw new Error(`${source.package}: the kit has ${tools.length} tools, and a kit may have at most ${MAX_KIT_TOOLS} (§10.2).`);
    }
    for (const tool of tools) {
      const problem = checkKitToolName(tool.name, manifest.tool_prefix);
      if (problem !== null) throw new Error(`${source.package}: ${problem}`);
      // Two prefixes can overlap: `wow` and `wow_get` can both name `wow_get_get_state`.
      const sameTool = byTool.get(tool.name);
      if (sameTool !== undefined) {
        throw new Error(`${sameTool} and ${source.package} both have a tool named "${tool.name}". Tool names must be unique.`);
      }
      byTool.set(tool.name, source.package);
    }

    kits.push({ source, manifest, adapterFolder: adapterFolder(source.package, manifest) });
  }
  return kits;
}

function adapterFolder(pkg: string, manifest: Manifest): string | null {
  if (manifest.adapter === undefined) return null;
  const folder = manifest.adapter.install.split(/[/\\]/).at(-1) ?? "";
  if (folder === "" || folder === "." || GLOB.test(folder)) {
    throw new Error(
      `${pkg}: adapter.install must end in the adapter's folder name, with no glob characters, e.g. "_*_/Interface/AddOns/OgreMCP".`,
    );
  }
  return folder;
}
