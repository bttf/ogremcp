import type { Pool } from "pg";

import { failureCode } from "./db.js";
import type { IngestStatus, UploadParse } from "./ingest.js";
import { logger } from "./log.js";
import type { ToolCallError } from "./tool-envelope.js";

/**
 * The events table (§11, §16): one row per MCP tool call (`tools.ts`) and one
 * per ingest request (`ingest.ts`), for the §16.1 metrics on `/admin`.
 *
 * Recording never breaks or slows a request. `record` starts the insert and
 * returns at once; it never throws. A failed insert is logged by its code
 * alone, and the request's answer stays what it was. At most `maxPending`
 * inserts wait on the database at once: an event past that is dropped and
 * logged, so a slow database cannot grow a queue without bound.
 *
 * A row holds no text the agent or the player wrote, except
 * search_game_info's normalized query: user data, which "Delete my data"
 * removes with the rest of the user's rows (§11, §16.2).
 *
 * Visits (§3) are not stored. `VISITS_SQL` derives them from the gaps
 * between a user's tool-call rows: the transport is stateless, so there are
 * no MCP session ids (D12).
 */

/** One tool call (§16). */
export interface ToolCallEvent {
  kind: "tool_call";
  /** `users.id`. */
  userId: string;
  occurredAt: Date;
  latencyMs: number;
  /** The OAuth client ID of the agent's access token. */
  agentClient: string;
  tool: string;
  /** The `sections` the tool's schema names, or null. */
  sections: string[] | null;
  /** A kit's flavor key, or null. */
  flavor: string | null;
  /** search_game_info's normalized query, or null. */
  query: string | null;
  /** Null when the call succeeded. */
  error: ToolCallError | null;
  /** When the snapshot the call returned was captured, or null. */
  snapshotAt: Date | null;
  cacheHit: boolean | null;
  searchCredits: number | null;
}

/** One ingest request that named its device (§8.3, §16.1). */
export interface IngestEvent {
  kind: "ingest";
  /** `users.id`. */
  userId: string;
  /** `devices.id`. */
  deviceId: string;
  occurredAt: Date;
  latencyMs: number;
  status: IngestStatus;
  /** The checked `meta`, or null when the request failed before it. */
  meta: {
    kit: string;
    kitVersion: string;
    bridgeVersion: string | null;
    os: string | null;
    errors: Record<string, number> | null;
  } | null;
  /** How the upload parsed, or null when it was not parsed. */
  parse: UploadParse | null;
}

export type RecordedEvent = ToolCallEvent | IngestEvent;

export interface EventRecorder {
  /** Starts the event's insert. Never throws, and never waits for the database. */
  record(event: RecordedEvent): void;
}

/** The most inserts that wait on the database at once, when `maxPending` is not given. */
export const DEFAULT_MAX_PENDING_EVENTS = 50;

export interface EventRecorderOptions {
  pool: Pool;
  /** Default: `DEFAULT_MAX_PENDING_EVENTS`. */
  maxPending?: number;
  /** Receives one line per event dropped or not written. Default: `logger.error`. */
  log?: (line: string) => void;
}

/** The columns an insert sets, in its parameters' order. */
const COLUMNS = [
  "user_id",
  "occurred_at",
  "kind",
  "latency_ms",
  "agent_client",
  "tool",
  "sections",
  "flavor",
  "query",
  "error",
  "snapshot_age_seconds",
  "cache_hit",
  "search_credits",
  "device_id",
  "status",
  "parse_status",
  "kit",
  "kit_version",
  "adapter_schema",
  "bridge_version",
  "os",
  "client_errors",
] as const;

type Row = { [column in (typeof COLUMNS)[number]]?: unknown };

const INSERT_SQL = `insert into events (${COLUMNS.join(", ")}) values (${COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})`;

const INT_MAX = 2_147_483_647;

/** A whole number within the range of `integer`. */
function int(n: number): number {
  return Math.max(-INT_MAX, Math.min(INT_MAX, Math.round(n)));
}

/** The event's row. */
function row(event: RecordedEvent): Row {
  const common = { user_id: event.userId, occurred_at: event.occurredAt, kind: event.kind, latency_ms: int(Math.max(0, event.latencyMs)) };
  if (event.kind === "tool_call") {
    return {
      ...common,
      agent_client: event.agentClient,
      tool: event.tool,
      sections: event.sections,
      flavor: event.flavor,
      query: event.query,
      error: event.error,
      snapshot_age_seconds: event.snapshotAt === null ? null : int((event.occurredAt.getTime() - event.snapshotAt.getTime()) / 1000),
      cache_hit: event.cacheHit,
      search_credits: event.searchCredits,
    };
  }
  const { meta, parse } = event;
  return {
    ...common,
    device_id: event.deviceId,
    status: event.status,
    flavor: parse === null ? null : parse.status === "parsed" ? parse.parsed.flavor : parse.rejectedFlavor,
    parse_status: parse?.status ?? null,
    kit: meta?.kit ?? null,
    kit_version: meta?.kitVersion ?? null,
    adapter_schema: parse?.parsed?.adapterSchema ?? null,
    bridge_version: meta?.bridgeVersion ?? null,
    os: meta?.os ?? null,
    client_errors: meta?.errors == null ? null : JSON.stringify(meta.errors),
  };
}

export function createEventRecorder({ pool, maxPending = DEFAULT_MAX_PENDING_EVENTS, log = logger.error }: EventRecorderOptions): EventRecorder {
  let pending = 0;
  function note(line: string): void {
    try {
      log(line);
    } catch {
      // Recording never breaks the request.
    }
  }
  return {
    record(event) {
      if (pending >= maxPending) return note(`event dropped: kind=${event.kind} pending=${pending}`);
      const failed = (err: unknown): void => note(`event insert failed: kind=${event.kind} code=${failureCode(err)}`);
      let insert: Promise<unknown>;
      try {
        const values = row(event);
        insert = pool.query(INSERT_SQL, COLUMNS.map((column) => values[column] ?? null));
      } catch (err) {
        return failed(err);
      }
      pending += 1;
      insert.then(
        () => {
          pending -= 1;
        },
        (err: unknown) => {
          pending -= 1;
          failed(err);
        },
      );
    },
  };
}

/**
 * The gap between two tool calls of a user that starts a new visit, in
 * minutes, when none is given (*proposed*). Visits group like stints (§11,
 * §16), whose proposed gap is 30 minutes.
 */
export const DEFAULT_VISIT_GAP_MINUTES = 30;

/**
 * One row per visit (§3) that starts in `[$2, $3)`: a user's tool calls
 * with no gap between two of them longer than `$1` seconds. A visit is one
 * user's, whatever agent clients made its calls. Ordered by start.
 *
 * A call at `$2` or later whose previous call is before `$2` starts a
 * visit here, so a visit that spans `$2` is cut there. `/admin` can use it
 * as a subquery.
 */
export const VISITS_SQL = `
select u.uuid as user_uuid, v.started_at, v.ended_at, v.calls, v.tools, v.agent_clients
  from (
    select user_id, min(occurred_at) as started_at, max(occurred_at) as ended_at, count(*)::int as calls,
           array_agg(distinct tool order by tool) as tools,
           array_agg(distinct agent_client order by agent_client) as agent_clients
      from (
        select user_id, occurred_at, tool, agent_client,
               count(*) filter (where starts) over (partition by user_id order by occurred_at, id) as visit
          from (
            select id, user_id, occurred_at, tool, agent_client,
                   coalesce(occurred_at - lag(occurred_at) over (partition by user_id order by occurred_at, id)
                              > make_interval(secs => $1), true) as starts
              from events
             where kind = 'tool_call' and occurred_at >= $2 and occurred_at < $3
          ) calls
      ) numbered
     group by user_id, visit
  ) v
  join users u on u.id = v.user_id
 order by v.started_at, u.uuid`;

export interface Visit {
  /** `users.uuid`. */
  userUuid: string;
  startedAt: Date;
  endedAt: Date;
  calls: number;
  /** The tools called, in name order. */
  tools: string[];
  /** The OAuth client IDs of the agents that called them, in order. */
  agentClients: string[];
}

export interface VisitsQuery {
  /** The first start time. */
  since: Date;
  /** The end of the window: visits start before it. Default: now. */
  until?: Date;
  /** Default: `DEFAULT_VISIT_GAP_MINUTES`. */
  gapMinutes?: number;
}

/** The visits of `VISITS_SQL`. */
export async function listVisits(pool: Pool, { since, until = new Date(), gapMinutes = DEFAULT_VISIT_GAP_MINUTES }: VisitsQuery): Promise<Visit[]> {
  const { rows } = await pool.query<{
    user_uuid: string;
    started_at: Date;
    ended_at: Date;
    calls: number;
    tools: string[];
    agent_clients: string[];
  }>(VISITS_SQL, [gapMinutes * 60, since, until]);
  return rows.map((row) => ({
    userUuid: row.user_uuid,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    calls: row.calls,
    tools: row.tools,
    agentClients: row.agent_clients,
  }));
}
