// Generated from manifest.schema.json by manifest.test.ts. Do not edit.
// After a schema change, regenerate with: pnpm --filter @ogremcp/sdk test -u

export type LocateEntry = LocatePath | LocatePrompt;
/**
 * An https URL prefix: a host, then a path that starts and ends with `/`, with no query or fragment (§12).
 */
export type UrlPrefix = string;

/**
 * A kit manifest. It tells the generic bridge what to read and where to find it (docs/architecture.md §6.1).
 */
export interface Manifest {
  /**
   * The kit's ID in lowercase snake_case, e.g. `wow`. It appears in URL paths such as `/api/v1/kits/{kit}/manifest` (§8.2).
   */
  kit: string;
  /**
   * The kit's version: semver `MAJOR.MINOR.PATCH` with an optional pre-release. The bridge updates only to a newer version and never downgrades (§7).
   */
  version: string;
  /**
   * The compatible `@ogremcp/sdk` version range, e.g. `^0.1.0`.
   */
  sdk: string;
  /**
   * Prefix for this kit's MCP tools, which are named `{tool_prefix}_{verb}_{noun}` (§10.1). Lowercase snake_case, at most 60 characters, so that a tool name fits in 64.
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
   * The single registry of per-flavor config, keyed by flavor (§6.4). Ingest rejects a payload whose flavor is not a key here (§8.3). `unknown` is reserved for payloads that map to no flavor (§6.3.1), so it is not a valid key.
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
   * A glob, relative to root, that must match under a candidate root for it to count. No variables, and it may not leave root.
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
   * Where the bridge installs the adapter, relative to root. Globs expand to each existing match. No variables, and it may not leave root.
   */
  install: string;
  /**
   * Globs for the game's process names. The bridge applies adapter updates only while none is running (§7). A glob matches a process's executable name, ignoring case. `*` is the only wildcard; `?`, `[`, `/`, and `\` are not allowed, since a glob with them would match no process.
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
   * Relative to root. Globs allowed; the bridge watches every match. No variables, and it may not leave root.
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
   * The flavor's search scope (§12). Each entry is an https URL prefix, not a bare domain: a host, then a path that starts and ends with `/`, with no query or fragment, e.g. `https://www.wowhead.com/classic/`. The final `/` keeps `/classic/` from admitting `/classic-ptr/`. Empty means no vetted sources yet.
   */
  search: UrlPrefix[];
  /**
   * The `search` prefixes whose pages cover several game versions on the same page, such as a wiki that mixes retail and Classic. Each must also be in `search`, which the platform checks. Results from them carry `mixed_versions: true` (§12).
   */
  mixed?: UrlPrefix[];
}
