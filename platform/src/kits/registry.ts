// The kit registry (docs/architecture.md §5, §6.5). It is the only platform
// module that imports `@ogmcp/kit-*`, and it types each kit as an
// `Interpreter`. It imports a kit's interpreter by name and its manifest.json
// as JSON, and never re-exports a kit module (`pnpm lint:seams` checks both).
//
// Hosted runs only the first-class kits in `kits/`, at the deployed commit
// (§6.5): the static imports below. Nothing loads a kit at runtime.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { interpreter as wowInterpreter } from "@ogmcp/kit-wow";
import wowManifest from "@ogmcp/kit-wow/manifest.json" with { type: "json" };
import type { Interpreter, Manifest } from "@ogmcp/sdk";

import { ADAPTERS_DIR, type AdapterZip, readAdapterZip } from "./adapter.js";
import { checkKits, type KitSource } from "./validate.js";

// Only `resolve`: the registry finds kit files, and loads no module this way.
const { resolve } = createRequire(import.meta.url);

/** A kit's `adapter/` folder, next to the `manifest.json` that `manifestPath` names. */
function adapterDir(manifestPath: string): string {
  return join(dirname(manifestPath), "adapter");
}

/** The first-class kits (§6.5). The build zips their adapters; startup checks them. */
export const KIT_SOURCES: readonly KitSource[] = [
  {
    package: "@ogmcp/kit-wow",
    manifest: wowManifest,
    interpreter: wowInterpreter,
    adapterDir: adapterDir(resolve("@ogmcp/kit-wow/manifest.json")),
  },
];

/**
 * Each first-class kit's name as the web UI shows it, by kit key (§13.2). The
 * manifest has no display name, so the platform keeps them here. A kit without
 * one stops the start.
 */
export const KIT_NAMES: ReadonlyMap<string, string> = new Map([["wow", "World of Warcraft"]]);

/** A checked kit, as the rest of the platform sees it. */
export interface Kit {
  /** The manifest's `kit`, e.g. `wow`. */
  key: string;
  /** From `KIT_NAMES`, e.g. `World of Warcraft`. */
  name: string;
  /** The pinned manifest (§5, §8.2). */
  manifest: Manifest;
  interpreter: Interpreter<unknown>;
  /** The adapter zip the build made (§8.2), or null for an adapter-less kit. */
  adapter: AdapterZip | null;
}

export interface KitRegistry {
  /** Every kit, in registry order. */
  list(): readonly Kit[];
  get(key: string): Kit | undefined;
}

export interface KitRegistryOptions {
  /** Default: `KIT_SOURCES`. */
  sources?: readonly KitSource[];
  /** Where the build wrote the adapter zips. Default: `ADAPTERS_DIR`. */
  adaptersDir?: string;
}

/**
 * Checks every kit (`checkKits`), finds its name in `KIT_NAMES`, and reads its
 * adapter zip. The platform calls it at startup; it throws on the first
 * problem, so a bad kit stops the start.
 */
export function loadKitRegistry({ sources = KIT_SOURCES, adaptersDir = ADAPTERS_DIR }: KitRegistryOptions = {}): KitRegistry {
  const kits: Kit[] = checkKits(sources).map(({ source, manifest, adapterFolder }) => {
    const name = KIT_NAMES.get(manifest.kit);
    if (name === undefined) throw new Error(`${source.package}: kit "${manifest.kit}" has no name in KIT_NAMES.`);
    return {
      key: manifest.kit,
      name,
      manifest,
      interpreter: source.interpreter,
      adapter: adapterFolder === null ? null : readAdapterZip(adaptersDir, manifest.kit, adapterFolder),
    };
  });
  const byKey = new Map(kits.map((kit) => [kit.key, kit]));
  return {
    list: () => kits,
    get: (key) => byKey.get(key),
  };
}
