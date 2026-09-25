import { jsonResult, userError } from "@ogmcp/sdk";
import type { PoolClient } from "pg";

import { DEFAULT_VISIT_GAP_MINUTES } from "./events.js";
import { NOT_ENABLED_MESSAGE } from "./search-game-info.js";
import type { PlatformTool } from "./tools.js";

/**
 * `report_issue(game, note)` (§10.3, §16.2): records a problem the user
 * reports, as one `issues` row, with the agent's OAuth client.
 *
 * The agent passes a short note. The server attaches the context itself:
 *
 * - The current visit's recent tool calls, from the events table. The
 *   current visit (§3) is the user's tool calls back from now to the first
 *   gap longer than `DEFAULT_VISIT_GAP_MINUTES`, whatever agent client made
 *   them. The newest `REPORT_ISSUE_CALLS` of them are attached, oldest
 *   first, each with its time, tool, args summary, and error category (null
 *   when it succeeded), as the events row holds them. The call's own row is
 *   written after it answers, so it is not among them. Events rows are
 *   written without waiting, so a call made a moment before can be missing.
 * - The snapshot the agent read most recently: of the attached calls that
 *   returned a snapshot of `game` (`events.snapshot_uuid`), the most recent
 *   call's snapshot, by its uuid and `snapshot_at`. The row holds none of its
 *   state. A snapshot read only before the attached calls is not named.
 *
 * `game` must be one of the user's enabled games. `note` is trimmed and
 * holds 1 to `NOTE_MAX_CHARS` characters, and no U+0000, which Postgres
 * text cannot hold. A user records at most
 * `REPORT_ISSUE_MAX_PER_DAY` reports in 24 hours (*proposed*), so an agent
 * that loops cannot fill the table. Past it, and on a bad argument, the call
 * answers a `userError` (§10.5). A lock on the user's row orders the user's
 * reports, so two at once cannot both pass the count.
 *
 * The note and the attached queries are user data: deleting the user
 * deletes the rows, and "Delete my data" does too (§11, §16.2).
 *
 * It never touches the game (§16.2). It writes a row, so it is not
 * read-only, and it changes nothing that exists: `destructiveHint: false`
 * (§10.5).
 */

/** The most characters of a note. The `issues.note` check matches it. */
export const NOTE_MAX_CHARS = 1000;

/** Names what it covers, and carries the §10.5 rule that acts on it. */
const DESCRIPTION = [
  "Report a problem to Open Gamer MCP about one of the games the user has enabled: a wrong answer, game state that is wrong or out of date, or a search that missed what the user needed.",
  "Call it only when the user says an answer was wrong or asks to report a problem. Never call it on your own initiative or to flag your own uncertainty.",
  "`game` is a game key from list_games. `note` says what went wrong, in a sentence or two.",
  "The server attaches your recent tool calls and the snapshot you read, so the note need not repeat them.",
  "Returns the report's id.",
].join(" ");

/** What a recorded report answers. */
export const RECORDED_MESSAGE = "The report is recorded, with your recent tool calls. Tell the player it was sent.";

/** What a report past `REPORT_ISSUE_MAX_PER_DAY` answers. */
export function overLimitMessage(max: number): string {
  return `The report was not recorded: the player has sent ${max} reports in the last 24 hours, the most allowed. Tell the player to try again later.`;
}

interface Input {
  game: string;
  note: string;
}

/** One attached tool call, as `issues.calls` holds it. */
interface AttachedCall {
  occurred_at: string;
  tool: string;
  sections: string[] | null;
  flavor: string | null;
  query: string | null;
  error: string | null;
}

interface CallRow {
  occurred_at: Date;
  tool: string;
  sections: string[] | null;
  flavor: string | null;
  query: string | null;
  error: string | null;
  snapshot_uuid: string | null;
  snapshot_at: Date | null;
}

/**
 * The tool calls of the user `$1`'s current visit at `$2`, oldest first: of
 * the user's `$4` newest calls up to `$2`, those after the newest gap longer
 * than `$3` seconds. The gap after the newest call runs to `$2`. Each call
 * has the uuid and `snapshot_at` of the snapshot it returned when that
 * snapshot is of the kit `$5` and still exists, else nulls.
 */
const VISIT_CALLS_SQL = `
select occurred_at, tool, sections, flavor, query, error, snapshot_uuid, snapshot_at
  from (
    select gaps.*, bool_or(gap) over (order by occurred_at desc, id desc) as cut
      from (
        select newest.*,
               coalesce(lag(occurred_at) over (order by occurred_at desc, id desc), $2) - occurred_at > make_interval(secs => $3) as gap
          from (
            select e.id, e.occurred_at, e.tool, e.sections, e.flavor, e.query, e.error, s.uuid as snapshot_uuid, s.snapshot_at
              from events e
              left join snapshots s on s.uuid = e.snapshot_uuid and s.user_id = e.user_id and s.kit = $5
             where e.user_id = $1 and e.kind = 'tool_call' and e.occurred_at <= $2
             order by e.occurred_at desc, e.id desc
             limit $4
          ) newest
      ) gaps
  ) visit
 where not cut
 order by occurred_at, id`;

export const reportIssue: PlatformTool = {
  name: "report_issue",
  description: DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      game: { type: "string", description: "A game key, as list_games returns it." },
      note: { type: "string", minLength: 1, maxLength: NOTE_MAX_CHARS, description: "What went wrong, in a sentence or two." },
    },
    required: ["game", "note"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  async handler(args, ctx) {
    const input = readInput(args);
    if (typeof input === "string") return userError(input);
    const kit = ctx.games.find((game) => game.key === input.game);
    if (kit === undefined) return userError(NOT_ENABLED_MESSAGE);
    const { user, settings } = ctx;

    const client = await ctx.pool.connect();
    try {
      await client.query("begin");
      // Orders the user's reports, so two at once cannot both pass the count.
      // `no key update` leaves inserts that reference the user unblocked.
      await client.query("select 1 from users where id = $1 for no key update", [user.id]);
      const { rows: counted } = await client.query<{ count: number }>(
        "select count(*)::int as count from issues where user_id = $1 and created_at > now() - interval '24 hours'",
        [user.id],
      );
      if ((counted[0]?.count ?? 0) >= settings.reportIssueMaxPerDay) {
        await client.query("rollback");
        return userError(overLimitMessage(settings.reportIssueMaxPerDay));
      }

      const rows = await visitCalls(client, user.id, kit.key, settings.reportIssueCalls);
      const snapshot = rows.findLast((row) => row.snapshot_uuid !== null);
      const calls: AttachedCall[] = rows.map((row) => ({
        occurred_at: row.occurred_at.toISOString(),
        tool: row.tool,
        sections: row.sections,
        flavor: row.flavor,
        query: row.query,
        error: row.error,
      }));
      const { rows: inserted } = await client.query<{ uuid: string }>(
        `insert into issues (user_id, kit, note, agent_client, calls, snapshot_uuid, snapshot_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning uuid`,
        [user.id, kit.key, input.note, ctx.agentClient, JSON.stringify(calls), snapshot?.snapshot_uuid ?? null, snapshot?.snapshot_at ?? null],
      );
      const issue = inserted[0];
      if (issue === undefined) throw new Error("insert into issues returned no row");
      await client.query("commit");
      return jsonResult({ issue_id: issue.uuid, message: RECORDED_MESSAGE });
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },
};

/** The current visit's newest `limit` tool calls, oldest first (`VISIT_CALLS_SQL`). */
async function visitCalls(client: PoolClient, userId: string, kit: string, limit: number): Promise<CallRow[]> {
  const { rows } = await client.query<CallRow>(VISIT_CALLS_SQL, [userId, new Date(), DEFAULT_VISIT_GAP_MINUTES * 60, limit, kit]);
  return rows;
}

/** The checked arguments, with the note trimmed, or a user-facing message on a bad one. */
function readInput(args: unknown): Input | string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "The arguments must be an object with game and note.";
  const { game, note } = args as { [name: string]: unknown };
  if (typeof game !== "string" || game === "") return "game must be a game key, as list_games returns it.";
  const trimmed = typeof note === "string" ? note.trim() : "";
  if (trimmed === "") return "note must say what went wrong, in a sentence or two.";
  if (trimmed.includes("\u0000")) return "note must be plain text, without NUL characters.";
  // Characters as Postgres and JSON Schema count them: code points.
  if ([...trimmed].length > NOTE_MAX_CHARS) return `note must be at most ${NOTE_MAX_CHARS} characters. Say what went wrong in a sentence or two.`;
  return { game, note: trimmed };
}
