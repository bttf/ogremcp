import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolAnnotations, ToolDef, ToolInputSchema, ToolResult } from "@ogmcp/sdk";
import type { Pool } from "pg";

import type { EventRecorder } from "./events.js";
import { fetchGamePage } from "./fetch-game-page.js";
import type { Kit, KitRegistry } from "./kits/registry.js";
import { listGames } from "./list-games.js";
import { logger } from "./log.js";
import type { PageFetch } from "./pages.js";
import { reportIssue } from "./report-issue.js";
import type { ScopedSearch, SearchUsage } from "./search.js";
import { searchGameInfo } from "./search-game-info.js";
import { createToolContext, DEFAULT_TOOL_CONTEXT, findToolUser, type SnapshotRef, type ToolContextSettings, type ToolUser } from "./tool-context.js";
import { errorResult, gameOffResult, kitToolResult, type ToolAnswer, type ToolCallError } from "./tool-envelope.js";
import { checkPlatformToolName } from "./tool-names.js";
import { capReachedResult, createUsageMeter, type UsageMeter } from "./usage.js";

/**
 * The tool registry: the MCP tools each user may list and call (§10).
 *
 * A user's tools are the platform tools, then the tools of each kit the user
 * has enabled (a `user_games` row), in registry order. They are computed per
 * request, from the database (§10.2): a game the user enables or disables
 * shows up the next time the client lists tools. A kit tool call gets a
 * `ToolContext` for the user and the kit (`tool-context.ts`), a platform tool
 * call a `PlatformToolContext`. What a call answers is the response envelope
 * of `tool-envelope.ts` (§10.5).
 *
 * Each call of a tool the user may call is counted toward the user's daily
 * tool calls before the tool runs (`usage.ts`, §14). A call past the tier's
 * cap does not run and is not counted: it answers `capReachedResult`. A call
 * to a tool of a game the user has turned off runs nothing and is not
 * counted.
 *
 * Each call of a tool the user may call, or of a tool of a game the user has
 * turned off, writes one events row (`events.ts`, §16) once it has its
 * answer: the agent's OAuth client, the tool, the args summary, the latency,
 * the error category, the age of the snapshot it returned, and what a search
 * cost. The args summary is the `sections` the tool's schema names and a
 * `flavor` that is a kit's flavor key; a platform tool adds a query through
 * `ToolCallNotes`. No other argument is recorded: `character` and the like
 * are free text. A kit tool's snapshot is its envelope's `snapshot_at`, and
 * the row names it by uuid: the snapshot its `ToolContext` read with that
 * `snapshot_at`. `report_issue` attaches it (§16.2).
 *
 * Names are checked at startup: kit tools in `checkKits`, and platform tools,
 * and platform tools against kit tools, in `createToolRegistry` (§10.1).
 */

/** What a platform tool's handler gets. */
export interface PlatformToolContext {
  pool: Pool;
  user: ToolUser;
  /** The OAuth client ID of the agent that called. */
  agentClient: string;
  /** The kits the user has enabled, in registry order. */
  games: readonly Kit[];
  /** The tool call limits, such as `LIST_GAMES_CHARACTERS`. */
  settings: ToolContextSettings;
  /** Game-scoped search (§12), or null without `FIRECRAWL_API_KEY`. */
  search: ScopedSearch | null;
  /** Page fetches (§12), or null without `FIRECRAWL_API_KEY`. */
  fetchPage: PageFetch | null;
  /** What the handler adds to the call's events row. */
  event: ToolCallNotes;
}

/** What a platform tool's handler adds to its call's events row (§16). */
export interface ToolCallNotes extends SearchUsage {
  /** search_game_info's normalized query. User data (§16.2). */
  query?: string;
  /** When the snapshot the call returned was captured. */
  snapshotAt?: Date;
  /** The uuid of the snapshot whose state a kit tool call returned. */
  snapshotUuid?: string;
  /** Why an `isError` result is one, when not `user_error`. */
  error?: ToolCallError;
}

/** Who calls a tool: the user and the agent, from the access token (§9). */
export interface ToolCaller {
  /** `users.uuid`. */
  userUuid: string;
  /** The OAuth client ID of the agent. */
  clientId: string;
}

/** A platform tool (§10.3): named `{verb}_{noun}`, with no prefix, and listed for every user. */
export interface PlatformTool {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  annotations?: ToolAnnotations;
  handler(args: unknown, ctx: PlatformToolContext): Promise<ToolResult>;
}

/** The platform tools (§10.3), in the order `tools/list` lists them. */
export const PLATFORM_TOOLS: readonly PlatformTool[] = [listGames, searchGameInfo, fetchGamePage, reportIssue];

export interface ToolRegistryOptions {
  pool: Pool;
  /** The first-class kits. Left out, no kit tool is listed. */
  kits?: KitRegistry;
  /** Default: `PLATFORM_TOOLS`. */
  platformTools?: readonly PlatformTool[];
  /**
   * The tool call limits (`HISTORY_MAX_SNAPSHOTS`, `TOOL_RESULT_MAX_BYTES`, `LIST_GAMES_CHARACTERS`,
   * `FETCH_PAGE_MAX_CHARS`, `REPORT_ISSUE_MAX_PER_DAY`, `REPORT_ISSUE_CALLS`). Default: `DEFAULT_TOOL_CONTEXT`.
   */
  settings?: ToolContextSettings;
  /** Game-scoped search, for `search_game_info` (§12). Default: null, and the tool answers `search_unavailable`. */
  search?: ScopedSearch | null;
  /** Page fetches, for `fetch_game_page` (§12). Default: null, and the tool answers `search_unavailable`. */
  fetchPage?: PageFetch | null;
  /**
   * Receives one line per tool call that failed with an error that is not
   * user-facing, or whose result was over the size cap. Default: `logger.error`.
   */
  log?: (line: string) => void;
  /** Where each call's events row goes (§16). Default: none, and nothing is recorded. */
  events?: EventRecorder;
  /** Counts each call and applies the daily caps (§14). Default: counts on `pool`, with no cap. */
  usage?: UsageMeter;
}

export interface ToolRegistry {
  /** The tools of the user with this `users.uuid`, as `tools/list` lists them. */
  list(userUuid: string): Promise<Tool[]>;
  /**
   * Calls the tool `name` for the caller's user, and answers with the
   * response envelope (`tool-envelope.ts`): a kit tool's result is checked,
   * the handler's errors become `isError` results, and a tool of a game the
   * user has not enabled gets an `isError` result that says the game is
   * turned off, and a call past the daily cap gets one that says when the
   * count resets. Null when there is no user with this uuid or no tool of
   * that name; neither writes an events row. An error while looking up the
   * user or counting the call propagates.
   */
  call(caller: ToolCaller, name: string, args: unknown): Promise<ToolResult | null>;
}

/** A tool the user may call, with what its call needs. */
type UserTool = { def: PlatformTool; kit: null } | { def: ToolDef<unknown>; kit: Kit };

/**
 * The tool registry of `kits` and `platformTools`. Throws when a platform
 * tool's name breaks §10.1, or when two tools share a name, so that a bad
 * name stops the start.
 */
export function createToolRegistry({
  pool,
  kits,
  platformTools = PLATFORM_TOOLS,
  settings = DEFAULT_TOOL_CONTEXT,
  search = null,
  fetchPage = null,
  log = logger.error,
  events,
  usage = createUsageMeter({ pool }),
}: ToolRegistryOptions): ToolRegistry {
  const allKits = kits?.list() ?? [];
  checkPlatformTools(platformTools, allKits);

  /** The user and their tools, or null when no user has this uuid. */
  async function userTools(userUuid: string): Promise<{ user: ToolUser; games: Kit[]; tools: UserTool[] } | null> {
    const user = await findToolUser(pool, userUuid);
    if (user === null) return null;
    const { rows } = await pool.query<{ kit: string }>("select kit from user_games where user_id = $1", [user.id]);
    const enabled = new Set(rows.map((row) => row.kit));
    const games = allKits.filter((kit) => enabled.has(kit.key));
    const tools: UserTool[] = [
      ...platformTools.map((def) => ({ def, kit: null })),
      ...games.flatMap((kit) => kit.interpreter.tools.map((def) => ({ def, kit }))),
    ];
    return { user, games, tools };
  }

  return {
    async list(userUuid) {
      const found = await userTools(userUuid);
      return (found?.tools ?? []).map(({ def }) => ({
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema,
        ...(def.annotations && { annotations: def.annotations }),
      }));
    },

    async call(caller, name, args) {
      const occurredAt = new Date();
      const started = performance.now();
      const found = await userTools(caller.userUuid);
      if (found === null) return null;
      const { user, games } = found;
      const event: ToolCallNotes = {};
      let answer: ToolAnswer;
      let schema: ToolInputSchema;
      const tool = found.tools.find(({ def }) => def.name === name);
      // Before the tool runs, so that a call past the cap costs nothing (§14).
      const capped = tool === undefined ? null : await usage.count(user);
      if (tool !== undefined && capped !== null) {
        schema = tool.def.inputSchema;
        answer = { result: capReachedResult(capped), error: "cap_reached" };
      } else if (tool !== undefined) {
        schema = tool.def.inputSchema;
        answer = await answerCall(tool, args, { pool, user, agentClient: caller.clientId, games, settings, search, fetchPage, event }, log);
      } else {
        // A client can keep a turned-off game's tools until a new chat (§10.2).
        const off = allKits.flatMap((kit) => kit.interpreter.tools.map((def) => ({ kit, def }))).find(({ def }) => def.name === name);
        if (off === undefined) return null;
        schema = off.def.inputSchema;
        answer = { result: gameOffResult(off.kit.name), error: "game_off" };
      }
      const snapshotAt = tool?.kit === null ? event.snapshotAt : envelopeSnapshotAt(answer);
      events?.record({
        kind: "tool_call",
        userId: user.id,
        occurredAt,
        latencyMs: performance.now() - started,
        agentClient: caller.clientId,
        tool: name,
        sections: knownSections(args, schema),
        flavor: knownFlavor(args, allKits),
        query: event.query ?? null,
        error: answer.error === "user_error" ? (event.error ?? "user_error") : answer.error,
        snapshotAt: answer.error === null ? (snapshotAt ?? null) : null,
        snapshotUuid: answer.error === null ? (event.snapshotUuid ?? null) : null,
        cacheHit: event.cacheHit ?? null,
        searchCredits: event.searchCredits ?? null,
      });
      return answer.result;
    },
  };
}

/** Runs the handler of `tool`, and answers with the response envelope. */
async function answerCall(tool: UserTool, args: unknown, ctx: PlatformToolContext, log: (line: string) => void): Promise<ToolAnswer> {
  const { pool, user, settings } = ctx;
  try {
    if (tool.kit === null) {
      const result = await tool.def.handler(args, ctx);
      return { result, error: result.isError === true ? "user_error" : null };
    }
    const reads: SnapshotRef[] = [];
    const onRead = (snapshots: SnapshotRef[]) => reads.push(...snapshots);
    const result = await tool.def.handler(args, createToolContext({ pool, user, kit: tool.kit.key, settings, onRead }));
    const answer = kitToolResult(result, tool.def.name, settings.maxResultBytes, log);
    const at = envelopeSnapshotAt(answer)?.getTime();
    ctx.event.snapshotUuid = reads.find((read) => read.snapshotAt.getTime() === at)?.uuid;
    return answer;
  } catch (err) {
    return errorResult(err, tool.def.name, log);
  }
}

/** The `snapshot_at` of a kit tool's answer (§10.5), or undefined. */
function envelopeSnapshotAt({ result }: ToolAnswer): Date | undefined {
  const value = result.structuredContent?.["snapshot_at"];
  if (typeof value !== "string") return undefined;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

/** The names in `args.sections` that the tool's schema lists for `sections`, in schema order, or null. */
function knownSections(args: unknown, schema: ToolInputSchema): string[] | null {
  const given = argument(args, "sections");
  const items = (schema.properties?.["sections"] as { items?: { enum?: unknown } } | undefined)?.items?.enum;
  if (!Array.isArray(given) || !Array.isArray(items)) return null;
  const known = items.filter((name): name is string => typeof name === "string" && given.includes(name));
  return known.length === 0 ? null : known;
}

/** `args.flavor` when it is a flavor key of a kit, or null. */
function knownFlavor(args: unknown, kits: readonly Kit[]): string | null {
  const flavor = argument(args, "flavor");
  return typeof flavor === "string" && kits.some((kit) => Object.hasOwn(kit.manifest.flavors, flavor)) ? flavor : null;
}

function argument(args: unknown, name: string): unknown {
  return typeof args === "object" && args !== null && !Array.isArray(args) ? (args as { [name: string]: unknown })[name] : undefined;
}

/** Checks each platform tool's name (§10.1), and that no two tools share a name. */
function checkPlatformTools(platformTools: readonly PlatformTool[], kits: readonly Kit[]): void {
  const owners = new Map<string, string>();
  for (const kit of kits) {
    for (const tool of kit.interpreter.tools) owners.set(tool.name, `kit "${kit.key}"`);
  }
  for (const tool of platformTools) {
    const problem = checkPlatformToolName(tool.name);
    if (problem !== null) throw new Error(`platform tools: ${problem}`);
    const owner = owners.get(tool.name);
    if (owner !== undefined) throw new Error(`${owner} and the platform tools both have a tool named "${tool.name}". Tool names must be unique.`);
    owners.set(tool.name, "the platform tools");
  }
}
