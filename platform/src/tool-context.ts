import type { Character, Snapshot, ToolContext } from "@ogmcp/sdk";
import type { Pool } from "pg";

/**
 * The `ToolContext` of a kit tool call (§6.2): a tool handler's only way to
 * read snapshots. It reads the snapshots of one user and one kit, newest
 * first by `snapshot_at`, not by insert time, because offline uploads arrive
 * late (§11). The object holds `user`, `latest`, and `history`, and nothing
 * else: the pool and the user's `users.id` stay in its closures.
 *
 * `latest` returns the newest snapshot. `history` returns the snapshots from
 * `since` on, newest first, at most `limit` of them, and at most
 * `maxHistoryLimit`. Both take an optional `flavor`, which keeps only that
 * flavor's snapshots, and an optional `character`, resolved against the
 * characters of the user's snapshots of the kit, and of `flavor` when given:
 *
 * - `Name-Realm` names a character by name and realm, and a bare name by name
 *   alone. A name has no hyphen, so it ends at the first one. Both compare
 *   without regard to case. Realms also compare without whitespace, `-`, and
 *   `.`, as chat shows them: `Brannic-LivingFlame` names Brannic of Living
 *   Flame.
 * - The snapshots of every matching character key are read: the key stays
 *   the same when a character is renamed or moves realm, and a deleted
 *   character's name can come back with a new key.
 * - Matches with more than one key and more than one `Name-Realm` and
 *   flavor pair are ambiguous: the same `Name-Realm` in two flavors is two
 *   characters. An ambiguous name rejects with a `UserFacingError` that lists
 *   the matches as `Name-Realm (flavor)`, newest first. No match rejects with
 *   one too.
 *
 * A bad `since`, `limit`, or `character` also rejects with a
 * `UserFacingError`, so that the agent gets a tool result it can act on
 * (§10.5).
 *
 * Paid-only gating of `history` is not here yet (§14).
 *
 * The matching rule and the newest-first pick are adapted from
 * `sameCharacter()` and `select()` in `cloud/src/mcpTools.ts` in
 * bttf/wow-guide@df80260.
 */

/** The history limit (*proposed*, §0). `config.ts` reads it from the environment. */
export interface ToolContextSettings {
  /** `HISTORY_MAX_SNAPSHOTS`: the most snapshots one `history` call returns. A larger `limit` is cut to it. */
  maxHistoryLimit: number;
}

export const DEFAULT_TOOL_CONTEXT: ToolContextSettings = { maxHistoryLimit: 100 };

/**
 * A user-facing condition of a tool call (§10.5). Its message is plain
 * language for the agent to relay. The tool envelope turns it into a tool
 * result with `isError: true`, not a protocol error.
 */
export class UserFacingError extends Error {
  override name = "UserFacingError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** The user a tool call acts for. */
export interface ToolUser {
  /** `users.id`. Internal: no tool result or log line shows it (§11). */
  id: string;
  /** `users.uuid`. */
  uuid: string;
  tier: "free" | "paid";
}

/** The user with this `users.uuid`, or null. */
export async function findToolUser(pool: Pool, uuid: string): Promise<ToolUser | null> {
  const { rows } = await pool.query<ToolUser>("select id, uuid, tier from users where uuid = $1", [uuid]);
  return rows[0] ?? null;
}

export interface ToolContextOptions {
  pool: Pool;
  user: ToolUser;
  /** The manifest's `kit`, e.g. `wow`. */
  kit: string;
  settings: ToolContextSettings;
}

interface SnapshotRow {
  snapshot_at: Date;
  flavor: string;
  rules: string[];
  character_key: string | null;
  character_name: string | null;
  character_realm: string | null;
  state: unknown;
}

interface CharacterRow {
  character_key: string;
  character_name: string;
  character_realm: string;
  flavor: string;
}

interface Query {
  flavor?: string;
  character?: string;
}

export function createToolContext({ pool, user, kit, settings }: ToolContextOptions): ToolContext<unknown> {
  /** The keys of the character `wanted` names (see the module comment). */
  async function characterKeys(wanted: string, flavor: string | undefined): Promise<string[]> {
    const params: unknown[] = [user.id, kit];
    let sql =
      "select character_key, character_name, character_realm, flavor from snapshots where user_id = $1 and kit = $2 and character_key is not null";
    if (flavor !== undefined) {
      params.push(flavor);
      sql += ` and flavor = $${params.length}`;
    }
    sql += " group by character_key, character_name, character_realm, flavor order by max(snapshot_at) desc";
    const { rows } = await pool.query<CharacterRow>(sql, params);

    const matches = rows.filter((row) => sameCharacter(row, wanted));
    if (matches.length === 0) {
      throw new UserFacingError(
        flavor === undefined
          ? "None of your characters with a snapshot has that name."
          : "None of your characters with a snapshot in that flavor has that name.",
      );
    }
    const keys = [...new Set(matches.map((row) => row.character_key))];
    const names = new Map<string, string>();
    for (const row of matches) {
      const name = `${row.character_name}-${row.character_realm} (${row.flavor})`;
      if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
    }
    if (keys.length > 1 && names.size > 1) {
      throw new UserFacingError(
        `More than one of your characters has that name: ${[...names.values()].join(", ")}. Name one as Name-Realm, with its flavor when two share a Name-Realm.`,
      );
    }
    return keys;
  }

  /** The user's snapshots of the kit that match `q` and `since`, newest first, at most `limit`. */
  async function read(q: Query, since: Date | null, limit: number): Promise<Snapshot<unknown>[]> {
    const flavor = q.flavor;
    const params: unknown[] = [user.id, kit];
    let sql = `select snapshot_at, flavor, rules, character_key, character_name, character_realm, state
                 from snapshots where user_id = $1 and kit = $2`;
    if (flavor !== undefined) {
      params.push(flavor);
      sql += ` and flavor = $${params.length}`;
    }
    if (q.character !== undefined) {
      if (typeof q.character !== "string") throw new UserFacingError("character must be a name or Name-Realm.");
      const keys = await characterKeys(q.character, flavor);
      // One key is the common case, and an equality keeps the index's order.
      params.push(keys.length === 1 ? keys[0] : keys);
      sql += keys.length === 1 ? ` and character_key = $${params.length}` : ` and character_key = any($${params.length}::text[])`;
    }
    if (since !== null) {
      params.push(since);
      sql += ` and snapshot_at >= $${params.length}`;
    }
    params.push(limit);
    sql += ` order by snapshot_at desc, id desc limit $${params.length}`;
    const { rows } = await pool.query<SnapshotRow>(sql, params);
    return rows.map(toSnapshot);
  }

  return {
    user: { uuid: user.uuid, tier: user.tier },
    async latest(q) {
      const [snapshot] = await read(q, null, 1);
      return snapshot ?? null;
    },
    async history(q) {
      if (!(q.since instanceof Date) || Number.isNaN(q.since.getTime())) throw new UserFacingError("since must be a valid date and time.");
      if (!Number.isInteger(q.limit) || q.limit < 1) throw new UserFacingError("limit must be a whole number of 1 or more.");
      return read(q, q.since, Math.min(q.limit, settings.maxHistoryLimit));
    },
  };
}

/**
 * Whether `wanted`, a `Name-Realm` or a bare name, names the row's character.
 * Case-insensitive, and realms compare in `realmKey` form.
 */
function sameCharacter(row: CharacterRow, wanted: string): boolean {
  const w = wanted.toLowerCase();
  const hyphen = w.indexOf("-");
  if (hyphen === -1) return row.character_name.toLowerCase() === w.trim();
  return row.character_name.toLowerCase() === w.slice(0, hyphen).trim() && realmKey(row.character_realm) === realmKey(w.slice(hyphen + 1));
}

/** A realm as chat writes it, lowercase: without whitespace, `-`, and `.`. `Azjol-Nerub` is `azjolnerub`. */
function realmKey(realm: string): string {
  return realm.toLowerCase().replace(/[\s.-]/g, "");
}

function toSnapshot(row: SnapshotRow): Snapshot<unknown> {
  const character: Character | null =
    row.character_key === null || row.character_name === null || row.character_realm === null
      ? null
      : { key: row.character_key, name: row.character_name, realm: row.character_realm };
  return { snapshotAt: row.snapshot_at, flavor: row.flavor, rules: row.rules, character, state: row.state };
}
