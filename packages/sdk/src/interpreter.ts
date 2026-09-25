// The Interpreter interface: how a kit parses uploads and defines its MCP tools
// (docs/architecture.md §6.2).
import type { ToolAnnotations, ToolInputSchema, ToolResult } from "./mcp.js";

/**
 * A kit's server-side module. The platform types each kit as an
 * `Interpreter` (§5).
 */
export interface Interpreter<State> {
  /**
   * Parses one upload of the source `sourceId`. Pure: no DB or network.
   * Accepts the current adapter schema and the previous one. Throws
   * `ParseError` on bad or unsupported input, with the `ParseErrorFacts` it
   * read before it failed.
   */
  parse(sourceId: string, bytes: Uint8Array, options?: ParseOptions): Parsed<State>;
  tools: ToolDef<State>[];
}

/** Options of one `Interpreter.parse` call. */
export interface ParseOptions {
  /**
   * The time the upload's own timestamps are judged against, e.g. whether a
   * capture stamp lies in the future. Default: the current time. A re-parse
   * passes the upload's receipt time, so its result does not depend on the
   * day it runs (§11).
   */
  now?: Date;
}

/** The character a snapshot belongs to. */
export interface Character {
  /** Stable key, e.g. the WoW player GUID (§6.3). */
  key: string;
  name: string;
  realm: string;
}

/** Why an upload's flavor is "unknown" (§6.3.1). JSON-serializable. */
export interface UnknownFlavor {
  /** For logs, not for users. */
  reason: string;
  facts: Record<string, unknown> | null;
}

/**
 * What `Interpreter.parse` returns for one upload. No string in it, key or
 * value, holds U+0000, because Postgres refuses U+0000 in `text` and `jsonb`
 * (§11).
 */
export interface Parsed<State> {
  /** Mapped from the adapter's detection facts (§6.3.1). */
  flavor: string;
  /** E.g. `["hardcore"]`; `[]` on normal realms. */
  rules: string[];
  /**
   * Set only when `flavor` is "unknown": why, and the raw detection facts,
   * for the platform to log (§6.3.1). `parse` is pure, so it returns them
   * instead of logging. `facts` is null when the upload had none.
   */
  unknownFlavor?: UnknownFlavor;
  character: Character | null;
  /**
   * The adapter's capture stamp. When null, the platform falls back to the
   * bridge's mtime, then to the receipt time.
   */
  capturedAt: Date | null;
  adapterSchema: number;
  /** Top-level keys are the kit's `sections`. */
  state: State;
}

/**
 * A stored snapshot, as tool handlers see it (§3, §11). Every kit-tool
 * response includes its `snapshotAt`, `flavor`, `rules`, and `character`
 * (§10.5).
 */
export interface Snapshot<State> {
  /** When the game captured the state (§3): `Parsed.capturedAt`, or its fallback. */
  snapshotAt: Date;
  flavor: string;
  rules: string[];
  character: Character | null;
  state: State;
}

/** One MCP tool a kit defines (§10). */
export interface ToolDef<State> {
  /** `{tool_prefix}_{verb}_{noun}` (§10.1). Check it with `checkToolName`. */
  name: string;
  /** Names the game explicitly (§10.5). */
  description: string;
  inputSchema: ToolInputSchema;
  annotations?: ToolAnnotations;
  /**
   * Still listed for free users, who get an upgrade message instead of a
   * result (§10.2, §14).
   */
  paidOnly?: boolean;
  handler(args: unknown, ctx: ToolContext<State>): Promise<ToolResult>;
}

/**
 * A tool handler's only way to read snapshots (§6.2). The platform resolves
 * `character` (a name or `Name-Realm`, case-insensitive). It does not check
 * the tier: the platform's tool registry gates `paidOnly` tools before their
 * handler runs (§10.2, §14). An unknown or ambiguous `character`, or a bad
 * `since` or `limit`, rejects with an error whose message is user-facing
 * (§10.5). A handler lets it propagate: the platform turns it into an
 * `isError` result.
 */
export interface ToolContext<State> {
  user: { uuid: string; tier: "free" | "paid" };
  /**
   * The most UTF-8 bytes (`utf8Length`) one copy of the result's JSON may
   * take (§10.5, *proposed* config). Over it, the handler trims its result,
   * leaving out what matters least first, and says in the result what it left
   * out. The platform answers a result still over it with a user-facing error.
   */
  maxResultBytes: number;
  latest(q: { flavor?: string; character?: string }): Promise<Snapshot<State> | null>;
  history(q: {
    since: Date;
    flavor?: string;
    character?: string;
    limit: number;
  }): Promise<Snapshot<State>[]>;
}

/**
 * Facts the interpreter read from an upload before it failed. The platform
 * stores them with the failed upload, so parse errors can be counted by
 * adapter schema and flavor (§16.1). Each is absent when the interpreter had
 * not read it.
 */
export interface ParseErrorFacts {
  /** The upload's adapter schema. An integer. */
  adapterSchema?: number;
  /** The flavor its detection facts map to: a flavor key, or "unknown" (§6.3.1). */
  flavor?: string;
}

/**
 * Thrown by `Interpreter.parse` on bad or unsupported input. The message is
 * user-facing: the bridge shows it to the player (§6.2, §8.3).
 */
export class ParseError extends Error {
  override name = "ParseError";
  // `declare`: an absent fact is no property at all, not one set to undefined.
  declare readonly adapterSchema?: number;
  declare readonly flavor?: string;

  constructor(message: string, options?: ErrorOptions & ParseErrorFacts) {
    super(message, options);
    if (options?.adapterSchema !== undefined) this.adapterSchema = options.adapterSchema;
    if (options?.flavor !== undefined) this.flavor = options.flavor;
  }
}

const MAX_TOOL_NAME_LENGTH = 64;
const SNAKE_CASE = /^[a-z0-9]+(_[a-z0-9]+)*$/;

/**
 * Checks a kit tool's name against §10.1: it starts with `{toolPrefix}_`, is
 * lowercase snake_case (`[a-z0-9_]` only, so no dots), and is at most 64
 * characters. Returns why the name is invalid, or null if it is valid.
 */
export function checkToolName(name: string, toolPrefix: string): string | null {
  if (!name.startsWith(`${toolPrefix}_`)) {
    return `Tool name "${name}" must start with "${toolPrefix}_".`;
  }
  if (name.length > MAX_TOOL_NAME_LENGTH) {
    return `Tool name "${name}" is longer than ${MAX_TOOL_NAME_LENGTH} characters.`;
  }
  if (!SNAKE_CASE.test(name)) {
    return `Tool name "${name}" must be lowercase snake_case: [a-z0-9_] only, with no leading, trailing, or doubled "_".`;
  }
  return null;
}
