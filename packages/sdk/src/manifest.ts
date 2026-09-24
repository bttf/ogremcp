// Generated from manifest.schema.json by manifest.test.ts. Do not edit.
// After a schema change, regenerate with: pnpm --filter @ogmcp/sdk test -u

export type LocateEntry = LocatePath | LocatePrompt;

/**
 * A kit manifest. It tells the generic bridge what to read and where to find it (docs/architecture.md §6.1).
 */
export interface Manifest {
  /**
   * The kit's ID, e.g. `wow`.
   */
  kit: string;
  /**
   * The kit's version.
   */
  version: string;
  /**
   * The compatible `@ogmcp/sdk` version range, e.g. `^0.1.0`.
   */
  sdk: string;
  /**
   * Prefix for this kit's MCP tools, which are named `{tool_prefix}_{verb}_{noun}` (§10.1). Lowercase snake_case, `[a-z0-9_]` only. At most 60 characters, so that a tool name fits in 64.
   */
  tool_prefix: string;
  root: Root;
  adapter?: Adapter;
  /**
   * What the bridge reads.
   *
   * @minItems 1
   */
  sources: Source[];
  /**
   * The single registry of per-flavor config, keyed by flavor (§6.4). Ingest rejects a payload whose flavor is not a key here (§8.3).
   */
  flavors: {
    [k: string]: Flavor;
  };
}
/**
 * How the bridge finds the game's install folder.
 */
export interface Root {
  /**
   * An ordered chain. The bridge tries each entry in turn; if none resolves, it prompts the user.
   *
   * @minItems 1
   */
  locate: LocateEntry[];
  /**
   * A glob, relative to root, that must match under a candidate root for it to count. No variables.
   */
  verify: string;
}
export interface LocatePath {
  /**
   * A candidate install folder. Globs allowed. The only variables are `{PROGRAM_FILES_X86}` and `{HOME}`; no other `{` or `}` is allowed.
   */
  path: string;
}
export interface LocatePrompt {
  /**
   * The title of the folder picker the bridge shows the user.
   */
  prompt: string;
}
/**
 * The in-game adapter. Omit it for adapter-less kits.
 */
export interface Adapter {
  /**
   * Where the bridge installs the adapter, relative to root. Globs expand to each existing match. No variables.
   */
  install: string;
  /**
   * Globs for the game's process names. The bridge applies adapter updates only while none is running (§7).
   *
   * @minItems 1
   */
  process: string[];
}
/**
 * One kind of thing the bridge reads. Each file its path matches is a source instance.
 */
export interface Source {
  /**
   * The source's ID, sent as `source_id` at ingest (§8.3).
   */
  id: string;
  /**
   * Only `file` is implemented. New types are added to this enum.
   */
  type: "file";
  /**
   * Only `text` is implemented.
   */
  format: "text";
  /**
   * Relative to root. Globs allowed; the bridge watches every match. No variables.
   */
  path: string;
  /**
   * `on_change`: upload after writes settle (§7).
   */
  trigger: "on_change";
}
export interface Flavor {
  /**
   * `supported` (play-tested) or `experimental` (the agent caveats its answers).
   */
  status: "supported" | "experimental";
  /**
   * The flavor's search scope (§12). Each entry is a URL prefix with a scheme, a host, and a path that starts with `/`, not a bare domain. Empty means no vetted sources yet.
   */
  search: string[];
}
