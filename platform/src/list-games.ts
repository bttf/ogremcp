import type { ToolResult } from "@ogmcp/sdk";

import type { Kit } from "./kits/registry.js";
import type { PlatformTool, PlatformToolContext } from "./tools.js";

/**
 * `list_games` (§10.3): the orientation call. It returns the user's enabled
 * games in registry order, each with its active flavor (the flavor of its
 * latest snapshot, §3), that snapshot's `snapshot_at`, and its most recent
 * characters, newest first. A character is a character key in one flavor:
 * the same `Name-Realm` in two flavors is two characters (§6.2). Each shows
 * the name and realm of its latest snapshot, so a renamed character shows
 * its new name. `last_active` is the game and flavor of the newest snapshot
 * of any enabled game.
 *
 * When no enabled game has a snapshot, the result also carries `note` and
 * the `setup` steps. That is a normal result, not an `isError` one: the
 * agent calls `list_games` to find out where the user stands, and a user
 * with nothing sent yet is one answer (§10.5 is about the tools that need a
 * snapshot). With no game enabled, `note` points to the Games page.
 *
 * Every query filters by the user's `users.id`, and the result holds no
 * serial id and no character key (§11). The queries read no `state`: one
 * reads each game's newest snapshot on `snapshots_user_kit_recent`, and one
 * walks `snapshots_user_kit_character_recent` with one index descent per
 * character (a recursive CTE), whatever the length of the user's history.
 */

const DESCRIPTION = [
  "The orientation call: the user's enabled games, the game and flavor they played last, and their recent characters, each with `snapshot_at` (when the game captured the state).",
  "Call it when unsure what the user is playing. With nothing sent yet, it returns the setup steps.",
].join(" ");

/** The setup steps, for when no enabled game has a snapshot. In the Get started page's order (§13.2). */
export const SETUP_STEPS: readonly string[] = [
  "Enable the game on the Games page of the Open Gamer MCP website. The bridge installs a game's addon only when the game is enabled.",
  "Install the Open Gamer MCP bridge on the computer that runs the game, from the Get started page of the website.",
  "Approve the bridge on the website, with the code the bridge shows.",
  "Type /transmit in World of Warcraft. If WoW was running when the bridge installed the addon, restart WoW first.",
];

export const NO_GAMES_NOTE =
  "No games are enabled. The player enables games on the Games page of the Open Gamer MCP website. A game's tools appear the next time the client lists tools, which in some clients means a new chat.";

export const NO_SNAPSHOT_NOTE = "No snapshot yet. The player sends the first one with the setup steps. Then call list_games again.";

interface CharacterSummary {
  name: string;
  realm: string;
  flavor: string;
  snapshot_at: string;
}

interface GameSummary {
  /** The kit key, e.g. `wow`: what a tool's `game` argument takes (§10.3). */
  game: string;
  name: string;
  active_flavor: string | null;
  snapshot_at: string | null;
  characters: CharacterSummary[];
}

interface LatestRow {
  flavor: string;
  snapshot_at: Date;
}

interface CharacterRow {
  flavor: string;
  character_name: string;
  character_realm: string;
  snapshot_at: Date;
}

/**
 * The newest snapshot of each (flavor, character key) of the user's
 * snapshots of one kit, as a loose index scan: each step finds the next
 * pair after the previous one, and its newest snapshot, with one descent of
 * `(user_id, kit, flavor, character_key, snapshot_at desc)`. Then the `$3`
 * newest of them.
 */
const RECENT_CHARACTERS_SQL = `
with recursive latest as (
  (select flavor, character_key, character_name, character_realm, snapshot_at
     from snapshots
    where user_id = $1 and kit = $2 and character_key is not null
    order by flavor, character_key, snapshot_at desc
    limit 1)
  union all
  select step.flavor, step.character_key, step.character_name, step.character_realm, step.snapshot_at
    from latest
   cross join lateral (
     select flavor, character_key, character_name, character_realm, snapshot_at
       from snapshots
      where user_id = $1 and kit = $2 and character_key is not null
        and (flavor, character_key) > (latest.flavor, latest.character_key)
      order by flavor, character_key, snapshot_at desc
      limit 1
   ) step
)
select flavor, character_name, character_realm, snapshot_at
  from latest
 order by snapshot_at desc
 limit $3`;

async function summarize({ pool, user, settings }: PlatformToolContext, kit: Kit): Promise<GameSummary> {
  const { rows: latest } = await pool.query<LatestRow>(
    "select flavor, snapshot_at from snapshots where user_id = $1 and kit = $2 order by snapshot_at desc limit 1",
    [user.id, kit.key],
  );
  const { rows: characters } = await pool.query<CharacterRow>(RECENT_CHARACTERS_SQL, [user.id, kit.key, settings.listGamesCharacters]);
  return {
    game: kit.key,
    name: kit.name,
    active_flavor: latest[0]?.flavor ?? null,
    snapshot_at: latest[0]?.snapshot_at.toISOString() ?? null,
    characters: characters.map((row) => ({
      name: row.character_name,
      realm: row.character_realm,
      flavor: row.flavor,
      snapshot_at: row.snapshot_at.toISOString(),
    })),
  };
}

export const listGames: PlatformTool = {
  name: "list_games",
  description: DESCRIPTION,
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
  async handler(_args, ctx) {
    const games: GameSummary[] = [];
    for (const kit of ctx.games) games.push(await summarize(ctx, kit));

    // `toISOString` strings, all UTC and of one length, compare as their times do.
    let lastActive: GameSummary | null = null;
    for (const game of games) {
      if (game.snapshot_at !== null && (lastActive === null || game.snapshot_at > (lastActive.snapshot_at ?? ""))) lastActive = game;
    }
    const result: { [key: string]: unknown } = {
      games,
      last_active: lastActive && { game: lastActive.game, flavor: lastActive.active_flavor, snapshot_at: lastActive.snapshot_at },
    };
    if (lastActive === null) {
      result["note"] = games.length === 0 ? NO_GAMES_NOTE : NO_SNAPSHOT_NOTE;
      result["setup"] = SETUP_STEPS;
    }
    return jsonResult(result);
  },
};

/** `structuredContent` plus the same JSON as a text block (§10.5). The envelope (RED-330) replaces it. */
function jsonResult(data: { [key: string]: unknown }): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}
