// The checks a kit passes before the platform uses it (docs/architecture.md
// §5, §6.1, §10.1). The platform runs them at startup and at build time, so a
// bad kit fails the build and the deploy, not a request.
import { checkToolName, type Interpreter, type Manifest } from "@ogmcp/sdk";
import schema from "@ogmcp/sdk/manifest.schema.json" with { type: "json" };
import { Ajv2020 } from "ajv/dist/2020.js";

/** A first-class kit as the registry lists it, before it is checked. */
export interface KitSource {
  /** The kit's package name, for messages. */
  package: string;
  /** The kit's `manifest.json`, checked against the SDK's manifest schema. */
  manifest: unknown;
  interpreter: Interpreter<unknown>;
  /**
   * A player-facing name for each flavor the interpreter maps to, by key, e.g.
   * `tbc_classic` → `TBC Classic`. Ingest names a flavor the manifest does not
   * register with it (§6.3.1, §8.3).
   */
  flavorNames: Readonly<Record<string, string>>;
  /** The kit's `adapter/` folder. The build zips it (§5, §8.2). */
  adapterDir: string;
}

/** A kit that passed every check. */
export interface CheckedKit {
  source: KitSource;
  manifest: Manifest;
  /**
   * The folder the adapter zip holds: the last segment of `adapter.install`,
   * e.g. `OpenGamerMCP`. Null for an adapter-less kit.
   */
  adapterFolder: string | null;
}

const ajv = new Ajv2020({ strict: true });
const validateManifest = ajv.compile<Manifest>(schema);

/** A glob character, which a folder name may not hold. */
const GLOB = /[*?[\]]/;

/**
 * Checks every kit: its manifest against the SDK schema, its kit key and
 * `tool_prefix` against every other kit's (§6.1), and its tool names with
 * `checkToolName` (§10.1). Throws on the first problem, naming the kit.
 */
export function checkKits(sources: readonly KitSource[]): CheckedKit[] {
  const kits: CheckedKit[] = [];
  const byKey = new Map<string, string>();
  const byPrefix = new Map<string, string>();
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

    for (const tool of source.interpreter.tools) {
      const problem = checkToolName(tool.name, manifest.tool_prefix);
      if (problem !== null) throw new Error(`${source.package}: ${problem}`);
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
      `${pkg}: adapter.install must end in the adapter's folder name, with no glob characters, e.g. "_*_/Interface/AddOns/OpenGamerMCP".`,
    );
  }
  return folder;
}
