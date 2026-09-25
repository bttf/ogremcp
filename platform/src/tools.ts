import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolAnnotations, ToolDef, ToolInputSchema, ToolResult } from "@ogmcp/sdk";
import type { Pool } from "pg";

import { failureCode } from "./db.js";
import type { Kit, KitRegistry } from "./kits/registry.js";
import { listGames } from "./list-games.js";
import { createToolContext, DEFAULT_TOOL_CONTEXT, findToolUser, type ToolContextSettings, type ToolUser, UserFacingError } from "./tool-context.js";
import { checkPlatformToolName } from "./tool-names.js";

/**
 * The tool registry: the MCP tools each user may list and call (§10).
 *
 * A user's tools are the platform tools, then the tools of each kit the user
 * has enabled (a `user_games` row), in registry order. They are computed per
 * request, from the database (§10.2): a game the user enables or disables
 * shows up the next time the client lists tools. A kit tool call gets a
 * `ToolContext` for the user and the kit (`tool-context.ts`), a platform tool
 * call a `PlatformToolContext`.
 *
 * Names are checked at startup: kit tools in `checkKits`, and platform tools,
 * and platform tools against kit tools, in `createToolRegistry` (§10.1).
 */

/** What a platform tool's handler gets. */
export interface PlatformToolContext {
  pool: Pool;
  user: ToolUser;
  /** The kits the user has enabled, in registry order. */
  games: readonly Kit[];
  /** The tool call limits, such as `LIST_GAMES_CHARACTERS`. */
  settings: ToolContextSettings;
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
export const PLATFORM_TOOLS: readonly PlatformTool[] = [listGames];

export interface ToolRegistryOptions {
  pool: Pool;
  /** The first-class kits. Left out, no kit tool is listed. */
  kits?: KitRegistry;
  /** Default: `PLATFORM_TOOLS`. */
  platformTools?: readonly PlatformTool[];
  /** The tool call limits (`HISTORY_MAX_SNAPSHOTS`, `LIST_GAMES_CHARACTERS`). Default: `DEFAULT_TOOL_CONTEXT`. */
  settings?: ToolContextSettings;
  /** Receives one line per tool call that failed with an error that is not user-facing. Default: `console.error`. */
  log?: (line: string) => void;
}

export interface ToolRegistry {
  /** The tools of the user with this `users.uuid`, as `tools/list` lists them. */
  list(userUuid: string): Promise<Tool[]>;
  /**
   * Calls the tool `name` for the user with this `users.uuid`. Null when the
   * user has no tool of that name: an unknown name, or a tool of a game the
   * user has not enabled. The handler's errors become `isError` results
   * (`toolErrorResult`); an error while looking up the user propagates.
   */
  call(userUuid: string, name: string, args: unknown): Promise<ToolResult | null>;
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
  log = console.error,
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

    async call(userUuid, name, args) {
      const found = await userTools(userUuid);
      const tool = found?.tools.find(({ def }) => def.name === name);
      if (found === null || tool === undefined) return null;
      const { user, games } = found;
      try {
        if (tool.kit === null) return await tool.def.handler(args, { pool, user, games, settings });
        return await tool.def.handler(args, createToolContext({ pool, user, kit: tool.kit.key, settings }));
      } catch (err) {
        return toolErrorResult(err, name, log);
      }
    },
  };
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

/** What the agent gets when a tool call fails for a reason it cannot act on. */
export const TOOL_FAILED_MESSAGE = "The tool failed on the server. Try again in a moment.";

/**
 * The result of a tool call whose handler threw. A `UserFacingError` becomes
 * an `isError` result with its message (§10.5). Anything else becomes an
 * `isError` result with `TOOL_FAILED_MESSAGE`, and a log line with the tool's
 * name and the error's code alone: its message can hold user data.
 *
 * Minimal until the response envelope (RED-330) replaces it.
 */
export function toolErrorResult(err: unknown, tool: string, log: (line: string) => void): ToolResult {
  if (err instanceof UserFacingError) return { isError: true, content: [{ type: "text", text: err.message }] };
  log(`tool call failed: tool=${tool} code=${failureCode(err)}`);
  return { isError: true, content: [{ type: "text", text: TOOL_FAILED_MESSAGE }] };
}
