import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolAnnotations, ToolDef, ToolInputSchema, ToolResult } from "@ogmcp/sdk";
import type { Pool } from "pg";

import type { Kit, KitRegistry } from "./kits/registry.js";
import { logger } from "./log.js";
import { createToolContext, DEFAULT_TOOL_CONTEXT, findToolUser, type ToolContextSettings, type ToolUser } from "./tool-context.js";
import { errorResult, gameOffResult, kitToolResult } from "./tool-envelope.js";
import { checkPlatformToolName } from "./tool-names.js";

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
 * Names are checked at startup: kit tools in `checkKits`, and platform tools,
 * and platform tools against kit tools, in `createToolRegistry` (§10.1).
 */

/** What a platform tool's handler gets. */
export interface PlatformToolContext {
  pool: Pool;
  user: ToolUser;
  /** The kits the user has enabled, in registry order. */
  games: readonly Kit[];
}

/** A platform tool (§10.3): named `{verb}_{noun}`, with no prefix, and listed for every user. */
export interface PlatformTool {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  annotations?: ToolAnnotations;
  handler(args: unknown, ctx: PlatformToolContext): Promise<ToolResult>;
}

/** The platform tools (§10.3), in the order `tools/list` lists them. None yet: `list_games` is RED-328. */
export const PLATFORM_TOOLS: readonly PlatformTool[] = [];

export interface ToolRegistryOptions {
  pool: Pool;
  /** The first-class kits. Left out, no kit tool is listed. */
  kits?: KitRegistry;
  /** Default: `PLATFORM_TOOLS`. */
  platformTools?: readonly PlatformTool[];
  /** The `ToolContext` settings (`HISTORY_MAX_SNAPSHOTS`, `TOOL_RESULT_MAX_BYTES`). Default: `DEFAULT_TOOL_CONTEXT`. */
  settings?: ToolContextSettings;
  /**
   * Receives one line per tool call that failed with an error that is not
   * user-facing, or whose result was over the size cap. Default: `logger.error`.
   */
  log?: (line: string) => void;
}

export interface ToolRegistry {
  /** The tools of the user with this `users.uuid`, as `tools/list` lists them. */
  list(userUuid: string): Promise<Tool[]>;
  /**
   * Calls the tool `name` for the user with this `users.uuid`, and answers
   * with the response envelope (`tool-envelope.ts`): a kit tool's result is
   * checked, the handler's errors become `isError` results, and a tool of a
   * game the user has not enabled gets an `isError` result that says the game
   * is turned off. Null when there is no user with this uuid or no tool of
   * that name. An error while looking up the user propagates.
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
  log = logger.error,
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
      if (found === null) return null;
      const tool = found.tools.find(({ def }) => def.name === name);
      if (tool === undefined) {
        // A client can keep a turned-off game's tools until a new chat (§10.2).
        const off = allKits.find((kit) => kit.interpreter.tools.some((def) => def.name === name));
        return off === undefined ? null : gameOffResult(off.name);
      }
      const { user, games } = found;
      try {
        if (tool.kit === null) return await tool.def.handler(args, { pool, user, games });
        const result = await tool.def.handler(args, createToolContext({ pool, user, kit: tool.kit.key, settings }));
        return kitToolResult(result, name, settings.maxResultBytes, log);
      } catch (err) {
        return errorResult(err, name, log);
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
