import express, { type Router } from "express";
import type { Pool, PoolClient } from "pg";

import { DEFAULT_VISIT_GAP_MINUTES, VISITS_SQL } from "./events.js";
import { fetchGamePage } from "./fetch-game-page.js";
import { searchGameInfo } from "./search-game-info.js";
import { PLATFORM_TOOLS } from "./tools.js";
import { currentUser } from "./web-sessions.js";

/**
 * `/admin` (§13.2): the §16.1 metrics and the storage volume (§11), over a
 * window of the last `days` days. The web UI's Admin page shows them.
 *
 * - Only the users in `ADMIN_USER_UUIDS` may read them. The API checks the
 *   list on every request, and answers anyone else, signed in or not, the
 *   same 404 as a path that does not exist.
 * - One SQL query per §16.1 row, and one for storage. Each is parameterized
 *   and bounded by a LIMIT. They run one after another on one connection, in
 *   a read-only transaction, so every metric reads the same snapshot, under
 *   a `statement_timeout`.
 * - Aggregates only. No answer holds a user's uuid, a device's, or any other
 *   row's id. Search queries and issue notes are user data (§16.2), shown to
 *   admins only: queries cut to `QUERY_CHARS`, notes as the agent wrote them,
 *   never with a user. An agent client is its CIMD `client_id`, an https URL
 *   that names the agent product (§9). A client registered by DCR has a
 *   random `client_id` that can stand for one install, so it is shown as
 *   `DCR: ` and its registered name instead.
 */

/** The window when the request names none, in days. */
export const DEFAULT_ADMIN_WINDOW_DAYS = 7;

/**
 * The longest window, in days. At about the §11 volume, 50,000 tool calls a
 * day, the visits of 30 days take the grounding query under 2 seconds.
 */
export const MAX_ADMIN_WINDOW_DAYS = 30;

/** The most rows of one aggregate table. */
const ROWS = 100;

/** The most error counters shown per bridge version and OS. */
const COUNTERS = 20;

/** The most uncached queries shown, and the characters shown of each. */
const TOP_QUERIES = 50;
const QUERY_CHARS = 120;

/** The most issue notes shown, the newest first. */
const NOTES = 50;

/** The characters shown of a DCR client's registered name. */
const CLIENT_NAME_CHARS = 60;

/** The server cancels one query that runs longer, in milliseconds. */
const STATEMENT_TIMEOUT_MS = 5_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The platform tools. A visit that called any other tool, a kit tool, read state. */
const PLATFORM_TOOL_NAMES = PLATFORM_TOOLS.map((tool) => tool.name);

/** The tools that ground an answer in search results (§12). */
const SEARCH_TOOL_NAMES = [searchGameInfo.name, fetchGamePage.name];

/** The agent client of `column`, as the page shows it (see above). */
function agentLabel(column: string): string {
  return `case when ${column} like 'https://%' then ${column}
               else 'DCR: ' || coalesce(left(nullif((select oc.payload->>'client_name' from oidc_models oc
                                                      where oc.model = 'Client' and oc.oidc_id = ${column}), ''), ${CLIENT_NAME_CHARS}),
                                        '(no name)')
          end`;
}

/** Bridge (§16.1): ingest requests by bridge version and OS, with the bridge's error counters (§8.3). */
export interface BridgeRow {
  bridge_version: string | null;
  os: string | null;
  devices: number;
  requests: number;
  /**
   * The sums of `client.errors`, by counter, at most `COUNTERS` of them. The
   * bridge counts since its last upload stored as a row, so only those rows
   * are summed: `stored`, `parse_error`, and `unsupported_flavor`.
   */
  errors: Record<string, number>;
}

const BRIDGES_SQL = `
with versions as (
  select bridge_version, os, count(device_id)::int as devices, sum(requests)::int as requests
    from (select bridge_version, os, device_id, count(*) as requests
            from events
           where kind = 'ingest' and tool is null and occurred_at >= $1 and occurred_at < $2
           group by bridge_version, os, device_id) by_device
   group by bridge_version, os
   order by requests desc, bridge_version, os
   limit $3
), counters as (
  select bridge_version, os, jsonb_object_agg(key, total) as errors
    from (select bridge_version, os, key, total,
                 row_number() over (partition by bridge_version, os order by total desc, key) as rank
            from (select e.bridge_version, e.os, c.key, sum(c.value::bigint)::float8 as total
                    from events e
                   cross join lateral jsonb_each_text(case when jsonb_typeof(e.client_errors) = 'object' then e.client_errors end) c
                   where e.kind = 'ingest' and e.tool is null and e.occurred_at >= $1 and e.occurred_at < $2
                     and e.status in ('stored', 'parse_error', 'unsupported_flavor')
                   group by e.bridge_version, e.os, c.key) sums) ranked
   where rank <= $4
   group by bridge_version, os
)
select v.bridge_version, v.os, v.devices, v.requests, coalesce(c.errors, '{}'::jsonb) as errors
  from versions v
  left join counters c on c.bridge_version is not distinct from v.bridge_version and c.os is not distinct from v.os
 order by v.requests desc, v.bridge_version, v.os`;

/**
 * Ingest (§16.1): parsed uploads by kit version, and within it by adapter
 * schema and flavor. `version_total` marks a kit version's own row. A failed parse has no
 * adapter schema or flavor, so its uploads count under null for both.
 * `uploads` counts every parse: parsed, failed, and rejected.
 */
export interface ParseRow {
  kit: string | null;
  kit_version: string | null;
  version_total: boolean;
  adapter_schema: number | null;
  flavor: string | null;
  uploads: number;
  failed: number;
}

const PARSES_SQL = `
select kit, kit_version, grouping(adapter_schema, flavor) <> 0 as version_total, adapter_schema, flavor,
       count(*)::int as uploads,
       (count(*) filter (where parse_status = 'failed'))::int as failed
  from events
 where kind = 'ingest' and tool is null and occurred_at >= $1 and occurred_at < $2 and parse_status is not null
 group by grouping sets ((kit, kit_version), (kit, kit_version, adapter_schema, flavor))
 order by kit, kit_version, grouping(adapter_schema, flavor) desc, adapter_schema nulls first, flavor nulls first
 limit $3`;

/** Ingest (§16.1): `unsupported_flavor` answers by kit and flavor. */
export interface UnsupportedFlavorRow {
  kit: string | null;
  flavor: string | null;
  rejections: number;
  users: number;
}

const UNSUPPORTED_FLAVORS_SQL = `
select kit, flavor, count(*)::int as rejections, count(distinct user_id)::int as users
  from events
 where kind = 'ingest' and tool is null and occurred_at >= $1 and occurred_at < $2 and status = 'unsupported_flavor'
 group by kit, flavor
 order by rejections desc, kit, flavor
 limit $3`;

/** Freshness (§16.1): the age of the snapshot a tool call returned, by tool, in seconds. */
export interface SnapshotAgeRow {
  tool: string;
  reads: number;
  p50: number;
  p90: number;
  p99: number;
}

const SNAPSHOT_AGE_SQL = `
select tool, count(*)::int as reads,
       percentile_cont(array[0.5, 0.9, 0.99]) within group (order by snapshot_age_seconds) as percentiles
  from events
 where kind = 'tool_call' and occurred_at >= $1 and occurred_at < $2 and snapshot_age_seconds is not null
 group by tool
 order by tool
 limit $3`;

/** Tool surface (§16.1): calls per tool. `with_sections` counts the calls that named `sections`. */
export interface ToolRow {
  tool: string;
  calls: number;
  errors: number;
  with_sections: number;
}

/** Tool surface (§16.1): calls per tool and section. A call that named two sections counts for each. */
export interface SectionRow {
  tool: string;
  section: string;
  calls: number;
}

const TOOL_CALLS_SQL = `
select tool, null::text as section, count(*)::int as calls,
       (count(*) filter (where error is not null))::int as errors,
       (count(*) filter (where sections is not null))::int as with_sections
  from events
 where kind = 'tool_call' and occurred_at >= $1 and occurred_at < $2
 group by tool
union all
select e.tool, s.section, count(*)::int, (count(*) filter (where e.error is not null))::int, count(*)::int
  from events e
 cross join lateral unnest(e.sections) as s(section)
 where e.kind = 'tool_call' and e.occurred_at >= $1 and e.occurred_at < $2 and e.sections is not null
 group by e.tool, s.section
 order by tool, section nulls first
 limit $3`;

/**
 * Grounding (§16.1): visits (§3) by agent client. `read_state` counts the
 * visits that called a kit tool, and `read_state_no_search` those of them
 * that called neither `search_game_info` nor `fetch_game_page`. A visit of
 * two agent clients counts for each.
 */
export interface GroundingRow {
  agent_client: string;
  visits: number;
  read_state: number;
  read_state_no_search: number;
}

const GROUNDING_SQL = `
select label as agent_client, sum(visits)::int as visits, sum(read_state)::int as read_state,
       sum(read_state_no_search)::int as read_state_no_search
  from (
    select ${agentLabel("c.agent_client")} as label, c.visits, c.read_state, c.read_state_no_search
      from (
        select a.agent_client, count(*) as visits,
               count(*) filter (where not (v.tools <@ $4::text[])) as read_state,
               count(*) filter (where not (v.tools <@ $4::text[]) and not (v.tools && $5::text[])) as read_state_no_search
          from (${VISITS_SQL}) v
         cross join lateral unnest(v.agent_clients) as a(agent_client)
         group by a.agent_client
      ) c
  ) labeled
 group by label
 order by visits desc, label
 limit $6`;

/** Search (§16.1), by tool, for the tools that searched, fetched, or missed the scope. */
export interface SearchToolRow {
  tool: string;
  /** Calls the cache answered or missed. */
  lookups: number;
  hits: number;
  /** Firecrawl credits. */
  credits: number;
  /** `out_of_scope` answers. */
  scope_misses: number;
}

/** Search (§16.1): cache hit rate, Firecrawl cost per active user, and scope misses. */
export interface SearchMetrics extends Omit<SearchToolRow, "tool"> {
  /** Users with a tool call in the window. */
  active_users: number;
  tools: SearchToolRow[];
}

const SEARCH_SQL = `
select tool, count(distinct user_id)::int as users, count(cache_hit)::int as lookups,
       (count(*) filter (where cache_hit))::int as hits,
       coalesce(sum(search_credits), 0)::float8 as credits,
       (count(*) filter (where error = 'out_of_scope'))::int as scope_misses
  from events
 where kind = 'tool_call' and occurred_at >= $1 and occurred_at < $2
 group by grouping sets ((), (tool))
having grouping(tool) = 1 or count(cache_hit) > 0 or sum(search_credits) > 0 or count(*) filter (where error = 'out_of_scope') > 0
 order by grouping(tool) desc, tool
 limit $3`;

/** Search (§16.1): the queries `search_game_info` sent to Firecrawl most often. */
export interface UncachedQueryRow {
  /** The normalized query, cut to `QUERY_CHARS`. User data. */
  query: string;
  searches: number;
  users: number;
}

const UNCACHED_QUERIES_SQL = `
select left(query, $4) as query, count(*)::int as searches, count(distinct user_id)::int as users
  from events
 where kind = 'tool_call' and tool = $3 and occurred_at >= $1 and occurred_at < $2
   and cache_hit = false and query is not null
 group by 1
 order by searches desc, query
 limit $5`;

/** Quality (§16.1): `report_issue` reports, and the newest notes. */
export interface IssueMetrics {
  total: number;
  notes: IssueNote[];
}

export interface IssueNote {
  /** ISO 8601. */
  created_at: string;
  kit: string;
  agent_client: string;
  /** User data. */
  note: string;
}

const ISSUES_SQL = `
select i.created_at, i.kit, ${agentLabel("i.agent_client")} as agent_client, i.note, (count(*) over ())::int as total
  from issues i
 where i.created_at >= $1 and i.created_at < $2
 order by i.created_at desc, i.id desc
 limit $3`;

/** Pricing (§16.1): `cap_reached` answers by UTC day and the user's tier now. */
export interface CapHitRow {
  /** `YYYY-MM-DD`. */
  day: string;
  tier: string;
  hits: number;
  users: number;
}

const CAP_HITS_SQL = `
select to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD') as day, u.tier,
       count(*)::int as hits, count(distinct e.user_id)::int as users
  from events e
  join users u on u.id = e.user_id
 where e.kind = 'tool_call' and e.occurred_at >= $1 and e.occurred_at < $2 and e.error = 'cap_reached'
 group by 1, 2
 order by 1 desc, 2
 limit $3`;

/** Storage (§11): the database's size, and each table's, largest first. */
export interface StorageMetrics {
  database_bytes: number;
  tables: StorageTable[];
}

export interface StorageTable {
  table: string;
  /** With its indexes and TOAST. */
  bytes: number;
  /** Postgres's count of live rows, an estimate. */
  rows: number;
}

const STORAGE_SQL = `
select pg_database_size(current_database())::float8 as database_bytes,
       coalesce((select jsonb_agg(jsonb_build_object('table', t.relname, 'bytes', t.bytes, 'rows', t.rows) order by t.bytes desc, t.relname)
                   from (select c.relname, pg_total_relation_size(c.oid)::float8 as bytes, coalesce(s.n_live_tup, 0)::float8 as rows
                           from pg_class c
                           join pg_namespace n on n.oid = c.relnamespace
                           left join pg_stat_user_tables s on s.relid = c.oid
                          where n.nspname = current_schema() and c.relkind in ('r', 'p')
                          order by 2 desc, 1
                          limit $1) t), '[]'::jsonb) as tables`;

/** What `GET /api/v1/admin/metrics` answers. */
export interface AdminMetrics {
  /** The window: `[since, until)`, ISO 8601. */
  window: { days: number; since: string; until: string };
  bridges: BridgeRow[];
  parses: ParseRow[];
  unsupported_flavors: UnsupportedFlavorRow[];
  snapshot_age: SnapshotAgeRow[];
  tools: ToolRow[];
  sections: SectionRow[];
  grounding: GroundingRow[];
  search: SearchMetrics;
  uncached_queries: UncachedQueryRow[];
  issues: IssueMetrics;
  cap_hits: CapHitRow[];
  storage: StorageMetrics;
}

async function rows<T extends object>(client: PoolClient, sql: string, params: unknown[]): Promise<T[]> {
  return (await client.query<T>(sql, params)).rows;
}

/** The metrics of the `days` days before `now`. */
export async function adminMetrics(pool: Pool, { days, now = new Date() }: { days: number; now?: Date }): Promise<AdminMetrics> {
  const until = now;
  const since = new Date(now.getTime() - days * DAY_MS);
  const window = [since, until];
  const client = await pool.connect();
  let failed: Error | undefined;
  try {
    await client.query("begin isolation level repeatable read read only");
    await client.query("select set_config('statement_timeout', $1, true)", [String(STATEMENT_TIMEOUT_MS)]);

    const bridges = await rows<BridgeRow>(client, BRIDGES_SQL, [...window, ROWS, COUNTERS]);
    const parses = await rows<ParseRow>(client, PARSES_SQL, [...window, ROWS]);
    const unsupported = await rows<UnsupportedFlavorRow>(client, UNSUPPORTED_FLAVORS_SQL, [...window, ROWS]);
    const ages = await rows<{ tool: string; reads: number; percentiles: number[] }>(client, SNAPSHOT_AGE_SQL, [...window, ROWS]);
    const calls = await rows<ToolRow & { section: string | null }>(client, TOOL_CALLS_SQL, [...window, 2 * ROWS]);
    const grounding = await rows<GroundingRow>(client, GROUNDING_SQL, [
      DEFAULT_VISIT_GAP_MINUTES * 60,
      ...window,
      PLATFORM_TOOL_NAMES,
      SEARCH_TOOL_NAMES,
      ROWS,
    ]);
    const search = await rows<SearchToolRow & { tool: string | null; users: number }>(client, SEARCH_SQL, [...window, ROWS]);
    const queries = await rows<UncachedQueryRow>(client, UNCACHED_QUERIES_SQL, [...window, searchGameInfo.name, QUERY_CHARS, TOP_QUERIES]);
    const issues = await rows<Omit<IssueNote, "created_at"> & { created_at: Date; total: number }>(client, ISSUES_SQL, [...window, NOTES]);
    const capHits = await rows<CapHitRow>(client, CAP_HITS_SQL, [...window, ROWS]);
    const [storage] = await rows<StorageMetrics>(client, STORAGE_SQL, [ROWS]);

    await client.query("commit");

    const [overall, ...searchTools] = search;
    return {
      window: { days, since: since.toISOString(), until: until.toISOString() },
      bridges,
      parses,
      unsupported_flavors: unsupported,
      snapshot_age: ages.map(({ tool, reads, percentiles: [p50 = 0, p90 = 0, p99 = 0] }) => ({ tool, reads, p50, p90, p99 })),
      tools: calls.filter((row) => row.section === null).map(({ tool, calls, errors, with_sections }) => ({ tool, calls, errors, with_sections })),
      sections: calls.flatMap(({ tool, section, calls }) => (section === null ? [] : [{ tool, section, calls }])),
      grounding,
      search: {
        active_users: overall?.users ?? 0,
        lookups: overall?.lookups ?? 0,
        hits: overall?.hits ?? 0,
        credits: overall?.credits ?? 0,
        scope_misses: overall?.scope_misses ?? 0,
        tools: searchTools.map(({ tool, lookups, hits, credits, scope_misses }) => ({ tool: tool ?? "", lookups, hits, credits, scope_misses })),
      },
      uncached_queries: queries,
      issues: {
        total: issues[0]?.total ?? 0,
        notes: issues.map(({ created_at, kit, agent_client, note }) => ({ created_at: created_at.toISOString(), kit, agent_client, note })),
      },
      cap_hits: capHits,
      storage: storage ?? { database_bytes: 0, tables: [] },
    };
  } catch (err) {
    failed = err instanceof Error ? err : new Error("admin metrics failed");
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    // A connection whose query failed, or timed out, is dropped.
    client.release(failed);
  }
}

/** `days` of the query string: a whole number from 1 to `MAX_ADMIN_WINDOW_DAYS`, or null. Absent, the default. */
function windowDays(value: unknown): number | null {
  if (value === undefined) return DEFAULT_ADMIN_WINDOW_DAYS;
  if (typeof value !== "string" || !/^\d{1,3}$/.test(value)) return null;
  const days = Number(value);
  return days >= 1 && days <= MAX_ADMIN_WINDOW_DAYS ? days : null;
}

export interface AdminOptions {
  pool: Pool;
  /** `ADMIN_USER_UUIDS`: the `users.uuid` of the users who may read the metrics. Empty: nobody. */
  adminUserUuids: readonly string[];
}

/**
 * The API of the Admin page (§13.2). The web session middleware must run
 * before this router, and it must come before `apiRouter`, whose last route
 * answers every other `/api` path.
 *
 * - `GET /api/v1/admin/metrics?days=N`: the `AdminMetrics` of the last N
 *   days, a whole number from 1 to `MAX_ADMIN_WINDOW_DAYS`
 *   (default `DEFAULT_ADMIN_WINDOW_DAYS`). Another value answers 400
 *   `invalid_days`.
 *
 * A request from anyone but an admin, signed in or not, answers 404
 * `not_found`, as `apiRouter` answers a path that does not exist, so the
 * page's existence is not revealed. Every answer is `no-store`.
 */
export function adminRouter({ pool, adminUserUuids }: AdminOptions): Router {
  const admins = new Set(adminUserUuids);
  const router = express.Router();
  router.get("/api/v1/admin/metrics", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const user = currentUser(res);
    if (user === null || !admins.has(user.uuid)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const days = windowDays(req.query["days"]);
    if (days === null) {
      res.status(400).json({ error: "invalid_days" });
      return;
    }
    res.json(await adminMetrics(pool, { days }));
  });
  return router;
}
