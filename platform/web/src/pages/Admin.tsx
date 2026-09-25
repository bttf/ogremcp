import { useEffect, useState } from "react";

import { when } from "../dates.js";
import { NotFound } from "./NotFound.js";

/** What `GET /api/v1/admin/metrics` answers (`AdminMetrics` in `platform/src/admin.ts`). */
export interface AdminMetrics {
  window: { days: number; since: string; until: string };
  bridges: { bridge_version: string | null; os: string | null; devices: number; requests: number; errors: Record<string, number> }[];
  parses: {
    kit: string | null;
    kit_version: string | null;
    version_total: boolean;
    adapter_schema: number | null;
    flavor: string | null;
    uploads: number;
    failed: number;
  }[];
  unsupported_flavors: { kit: string | null; flavor: string | null; rejections: number; users: number }[];
  snapshot_age: { tool: string; reads: number; p50: number; p90: number; p99: number }[];
  tools: { tool: string; calls: number; errors: number; with_sections: number }[];
  sections: { tool: string; section: string; calls: number }[];
  grounding: { agent_client: string; visits: number; read_state: number; read_state_no_search: number }[];
  search: SearchCounts & { active_users: number; tools: (SearchCounts & { tool: string })[] };
  uncached_queries: { query: string; searches: number; users: number }[];
  issues: { total: number; notes: { created_at: string; kit: string; agent_client: string; note: string }[] };
  cap_hits: { day: string; tier: string; hits: number; users: number }[];
  storage: { database_bytes: number; tables: { table: string; bytes: number; rows: number }[] };
}

interface SearchCounts {
  lookups: number;
  hits: number;
  credits: number;
  scope_misses: number;
}

/** The windows the page offers, in days. `MAX_ADMIN_WINDOW_DAYS` in `platform/src/admin.ts` is the longest. */
const WINDOWS = [1, 7, 30] as const;

/** `DEFAULT_ADMIN_WINDOW_DAYS` in `platform/src/admin.ts`. */
const DEFAULT_WINDOW = 7;

/**
 * The metrics of the last `days` days, `not-found` for anyone but an admin,
 * or null when the service did not answer them or `signal` aborted the
 * request.
 */
async function loadMetrics(days: number, signal: AbortSignal): Promise<AdminMetrics | "not-found" | null> {
  try {
    const res = await fetch(`/api/v1/admin/metrics?days=${days}`, { headers: { Accept: "application/json" }, signal });
    if (res.status === 404) return "not-found";
    if (!res.ok) return null;
    return (await res.json()) as AdminMetrics;
  } catch {
    return null;
  }
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "–" : `${((100 * part) / whole).toFixed(1)}%`;
}

/** A duration in seconds, in the largest unit under it. Negative when the player's clock runs ahead. */
function duration(seconds: number): string {
  const size = Math.abs(seconds);
  if (size < 60) return `${Math.round(seconds)} s`;
  if (size < 3600) return `${(seconds / 60).toFixed(1)} min`;
  if (size < 86400) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86400).toFixed(1)} d`;
}

function bytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** A table of `rows`. A number cell is a count, right-aligned. */
function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  if (rows.length === 0) return <p className="og-hint">None in this window.</p>;
  return (
    <div className="og-table">
      <table>
        <thead>
          <tr>
            {head.map((label) => (
              <th key={label} scope="col">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i}>
              {cells.map((cell, j) =>
                typeof cell === "number" ? (
                  <td key={j} className="og-num">
                    {cell.toLocaleString()}
                  </td>
                ) : (
                  <td key={j}>{cell}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The Admin page (§13.2): the §16.1 metrics and the storage volume (§11) of
 * the last day, 7 days, or 30 days. It is read-only. Anyone but an admin gets
 * no data: the API answers 404, and the page shows the Page not found page,
 * as at a path that does not exist. Nothing on it names a user. A new window
 * aborts the request of the one before.
 */
export function Admin() {
  const [days, setDays] = useState<number>(DEFAULT_WINDOW);
  const [status, setStatus] = useState<"loading" | "ready" | "not-found" | "error">("loading");
  // The last metrics loaded. The heading shows once the API has answered one.
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);

  useEffect(() => {
    const request = new AbortController();
    setStatus("loading");
    void loadMetrics(days, request.signal).then((loaded) => {
      if (request.signal.aborted) return;
      if (loaded === "not-found" || loaded === null) {
        setStatus(loaded === null ? "error" : "not-found");
        return;
      }
      setMetrics(loaded);
      setStatus("ready");
    });
    return () => request.abort();
  }, [days]);

  if (status === "not-found") return <NotFound />;
  const failed = <p role="alert">Ogre MCP did not answer. Reload the page to try again.</p>;
  if (metrics === null) return status === "error" ? failed : <p>Loading…</p>;
  return (
    <div className="og-admin">
      <h1>Admin</h1>
      <label className="og-admin__window">
        Window
        <select value={days} onChange={(event) => setDays(Number(event.currentTarget.value))}>
          {WINDOWS.map((option) => (
            <option key={option} value={option}>
              {option === 1 ? "Last day" : `Last ${option} days`}
            </option>
          ))}
        </select>
      </label>
      {status === "loading" ? <p>Loading…</p> : status === "error" ? failed : <Metrics metrics={metrics} />}
    </div>
  );
}

function Metrics({ metrics }: { metrics: AdminMetrics }) {
  const { search, issues, storage } = metrics;
  return (
    <>
      <p className="og-hint">
        From {when(metrics.window.since)} to {when(metrics.window.until)}.
      </p>

      <h2>Bridge</h2>
      <p className="og-hint">Ingest requests by bridge version and OS, with the error counters the bridge sends.</p>
      <Table
        head={["Version", "OS", "Devices", "Requests", "Error counters"]}
        rows={metrics.bridges.map((row) => [
          row.bridge_version ?? "none",
          row.os ?? "none",
          row.devices,
          row.requests,
          Object.entries(row.errors)
            .map(([name, count]) => `${name} ${count.toLocaleString()}`)
            .join(", ") || "none",
        ])}
      />

      <h2>Parse errors</h2>
      <p className="og-hint">
        Parsed uploads by kit version, then by adapter schema and flavor. A failed parse shows none for each it failed before
        reading.
      </p>
      <Table
        head={["Kit", "Kit version", "Adapter schema", "Flavor", "Uploads", "Failed", "Rate"]}
        rows={metrics.parses.map((row) => [
          row.kit ?? "none",
          row.kit_version ?? "none",
          row.version_total ? "all" : (row.adapter_schema?.toString() ?? "none"),
          row.version_total ? "all" : (row.flavor ?? "none"),
          row.uploads,
          row.failed,
          percent(row.failed, row.uploads),
        ])}
      />

      <h2>Unsupported flavors</h2>
      <Table
        head={["Kit", "Flavor", "Rejections", "Users"]}
        rows={metrics.unsupported_flavors.map((row) => [row.kit ?? "none", row.flavor ?? "none", row.rejections, row.users])}
      />

      <h2>Snapshot age at read</h2>
      <Table
        head={["Tool", "Reads", "Median", "90th percentile", "99th percentile"]}
        rows={metrics.snapshot_age.map((row) => [row.tool, row.reads, duration(row.p50), duration(row.p90), duration(row.p99)])}
      />

      <h2>Calls per tool</h2>
      <Table
        head={["Tool", "Calls", "Errors", "With sections"]}
        rows={metrics.tools.map((row) => [row.tool, row.calls, row.errors, row.with_sections])}
      />

      <h2>Calls per section</h2>
      <p className="og-hint">A call that names two sections counts for each.</p>
      <Table head={["Tool", "Section", "Calls"]} rows={metrics.sections.map((row) => [row.tool, row.section, row.calls])} />

      <h2>Grounding</h2>
      <p className="og-hint">
        Visits by agent client. Read state: a call of a game&apos;s tool succeeded. Searched: a call of search_game_info or
        fetch_game_page succeeded.
      </p>
      <Table
        head={["Agent client", "Visits", "Read state", "Read state, never searched", "Share"]}
        rows={metrics.grounding.map((row) => [
          row.agent_client,
          row.visits,
          row.read_state,
          row.read_state_no_search,
          percent(row.read_state_no_search, row.read_state),
        ])}
      />

      <h2>Search</h2>
      <dl className="og-facts">
        <dt>Cache hit rate</dt>
        <dd>{percent(search.hits, search.lookups)}</dd>
        <dt>Firecrawl credits</dt>
        <dd>{search.credits.toLocaleString()}</dd>
        <dt>Active users</dt>
        <dd>{search.active_users.toLocaleString()}</dd>
        <dt>Credits per active user</dt>
        <dd>{search.active_users === 0 ? "–" : (search.credits / search.active_users).toFixed(1)}</dd>
        <dt>Scope misses</dt>
        <dd>{search.scope_misses.toLocaleString()}</dd>
      </dl>
      <Table
        head={["Tool", "Lookups", "Hits", "Hit rate", "Credits", "Scope misses"]}
        rows={search.tools.map((row) => [row.tool, row.lookups, row.hits, percent(row.hits, row.lookups), row.credits, row.scope_misses])}
      />

      <h2>Top uncached queries</h2>
      <p className="og-hint">User data. Each query is cut to 120 characters.</p>
      <Table
        head={["Query", "Searches", "Users"]}
        rows={metrics.uncached_queries.map((row) => [row.query, row.searches, row.users])}
      />

      <h2>Reported issues</h2>
      <p className="og-hint">{issues.total.toLocaleString()} in this window. The newest notes, which are user data.</p>
      <Table
        head={["When", "Game", "Agent client", "Note"]}
        rows={issues.notes.map((row) => [when(row.created_at), row.kit, row.agent_client, row.note])}
      />

      <h2>Cap hits</h2>
      <p className="og-hint">Calls refused at the daily cap, by UTC day and the user&apos;s tier now.</p>
      <Table head={["Day", "Tier", "Hits", "Users"]} rows={metrics.cap_hits.map((row) => [row.day, row.tier, row.hits, row.users])} />

      <h2>Storage</h2>
      <p className="og-hint">Database: {bytes(storage.database_bytes)}. Row counts are Postgres&apos;s estimates. Not limited to the window.</p>
      <Table
        head={["Table", "Size", "Rows"]}
        rows={storage.tables.map((row) => [row.table, bytes(row.bytes), row.rows])}
      />
    </>
  );
}
