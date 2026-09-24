/**
 * Spike S3 (RED-332, §12, §18.3): do `site:` filters plus URL-prefix
 * post-filtering return good Classic Era results from Firecrawl search?
 *
 * Throwaway. Not platform code. Findings: docs/spikes/s3-firecrawl-scoping.md.
 *
 * Run from the repo root with the key in the environment, e.g.
 *   node --env-file=<path to a .env with FIRECRAWL_API_KEY> spikes/s3/run.ts <command>
 *
 * Commands:
 *   credits                      remaining team credits (free call)
 *   search <variant> [ids...]    one search per question (all, or the ids given)
 *   fetch <variant> [ids...]     scrape the top in-scope hit of that variant's search
 *   summarize                    write spikes/s3/results.json from raw/
 *
 * Raw responses go to spikes/s3/raw/ (git-ignored): they hold page snippets
 * and page text. results.json keeps URLs, counts, timings, and credits.
 * The key goes in the Authorization header only and is never printed.
 *
 * The request shape, the post-filter, and `plain()` follow the prototype,
 * bttf/wow-guide@df80260: cloud/src/firecrawl.ts and cloud/src/search.ts.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const RAW = join(HERE, "raw");
const SEARCH_LOG = join(RAW, "search.jsonl");
const FETCH_LOG = join(RAW, "fetch.jsonl");
const API = "https://api.firecrawl.dev/v2";

/** Spend guard for the whole spike, counted from the raw logs. */
const MAX_SEARCH_CALLS = 40;
const MAX_FETCH_CALLS = 15;
/** Hits asked of Firecrawl. 1 to 10 hits cost the same 2 credits. */
const LIMIT = 10;
/** fetch_game_page's proposed truncation (§10.3). */
const FETCH_TRUNCATE = 20_000;
/** Gap between calls. The account's plan allows about 10 requests a minute. */
const PACE_MS = 6_500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Question {
  id: string;
  type: string;
  zone: string;
  query: string;
  expect: string[];
}

interface Hit {
  pos: number;
  url: string;
  title: string;
  description: string;
  inScope: boolean;
  category: string;
}

interface SearchRecord {
  variant: string;
  id: string;
  query: string;
  body: Record<string, unknown>;
  ms: number;
  status: number;
  creditsUsed: number | null;
  error: string | null;
  hits: Hit[];
}

// ---------------------------------------------------------------------------
// Scope, from the manifest
// ---------------------------------------------------------------------------

const manifest = JSON.parse(readFileSync(join(ROOT, "kits", "wow", "manifest.json"), "utf8")) as {
  flavors: Record<string, { search: string[] }>;
};
const PREFIXES: string[] = manifest.flavors["classic_era"]?.search ?? [];
if (PREFIXES.length === 0) throw new Error("classic_era has no search prefixes");

/** `www.wowhead.com/classic/` -> `wowhead.com`. */
function siteHost(prefix: string): string {
  return new URL(prefix).hostname.replace(/^www\./, "");
}

/** `https://www.wowhead.com/classic/` -> `wowhead.com/classic`; a bare host stays a host. */
function sitePrefix(prefix: string): string {
  const u = new URL(prefix);
  const path = u.pathname.replace(/\/+$/, "");
  return u.hostname.replace(/^www\./, "") + path;
}

function orSites(sites: string[]): string {
  return `(${[...new Set(sites)].map((s) => `site:${s}`).join(" OR ")})`;
}

/**
 * Query shapes under test. Each maps a question's query to a request body.
 * `host`: `site:` by hostname, the literal §12 reading.
 * `prefix`: `site:` with the manifest path, e.g. `site:wowhead.com/classic`.
 * `prefix_classic`: `prefix` plus the word "classic" in the query.
 * `host_classic`: `host` plus the word "classic" in the query.
 * `include_domains`: the prototype's shape, Firecrawl's `includeDomains`, no `site:`.
 * `domains_prefix`: `includeDomains` plus the `prefix` query.
 */
const VARIANTS: Record<string, (q: string) => Record<string, unknown>> = {
  host: (q) => ({ query: `${q} ${orSites(PREFIXES.map(siteHost))}` }),
  prefix: (q) => ({ query: `${q} ${orSites(PREFIXES.map(sitePrefix))}` }),
  prefix_classic: (q) => ({ query: `classic ${q} ${orSites(PREFIXES.map(sitePrefix))}` }),
  host_classic: (q) => ({ query: `classic ${q} ${orSites(PREFIXES.map(siteHost))}` }),
  include_domains: (q) => ({ query: q, includeDomains: [...new Set(PREFIXES.map(siteHost))] }),
  domains_prefix: (q) => ({ query: `${q} ${orSites(PREFIXES.map(sitePrefix))}`, includeDomains: [...new Set(PREFIXES.map(siteHost))] }),
};

/** The post-filter (§12): https, no credentials or port, and under a scope prefix. */
function inScope(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.port !== "") return false;
  return PREFIXES.some((p) => u.href.startsWith(p));
}

const WOWHEAD_LOCALES = new Set(["de", "es", "fr", "it", "pt", "ru", "ko", "cn", "tw", "mx"]);

/** Where a URL points, for scope-miss and contamination counts. */
function categorize(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "invalid";
  }
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split("/").filter(Boolean);
  if (host === "www.wowhead.com" || host === "wowhead.com") {
    let first = segs[0] ?? "";
    if (WOWHEAD_LOCALES.has(first)) first = segs[1] ?? "";
    if (first === "classic") {
      const second = segs[1] ?? "";
      if (WOWHEAD_LOCALES.has(second)) return "wowhead-classic-locale";
      if (host === "wowhead.com") return "wowhead-classic-no-www";
      // Guides, news, and forum threads are under /classic/ too.
      return second === "guide" || second === "news" || second === "forums" ? `wowhead-classic-${second}` : "wowhead-classic";
    }
    if (first === "" || first.includes("=")) return "wowhead-retail";
    return `wowhead-/${first}`;
  }
  if (host.endsWith(".wowhead.com")) return `wowhead-host:${host}`;
  if (host === "warcraft.wiki.gg") return "warcraft.wiki.gg";
  if (host.endsWith(".warcraft.wiki.gg")) return `wiki-host:${host}`;
  return `other:${host}`;
}

// ---------------------------------------------------------------------------
// Firecrawl
// ---------------------------------------------------------------------------

function apiKey(): string {
  const key = process.env["FIRECRAWL_API_KEY"]?.trim() ?? "";
  if (key === "") throw new Error("FIRECRAWL_API_KEY is not set");
  return key;
}

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; ms: number; json: unknown }> {
  const t0 = performance.now();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${apiKey()}`, "content-type": "application/json", accept: "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, ms: Math.round(performance.now() - t0), json };
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}

function questions(ids: string[]): Question[] {
  const all = JSON.parse(readFileSync(join(HERE, "questions.json"), "utf8")) as Question[];
  if (ids.length === 0) return all;
  const picked = all.filter((q) => ids.includes(q.id));
  if (picked.length !== ids.length) throw new Error(`unknown question id in ${ids.join(",")}`);
  return picked;
}

async function credits(): Promise<void> {
  const { status, json } = await call("GET", "/team/credit-usage");
  const data = (json as { data?: { remainingCredits?: number; planCredits?: number } } | null)?.data;
  console.log(JSON.stringify({ status, remainingCredits: data?.remainingCredits, planCredits: data?.planCredits }));
}

async function search(variant: string, ids: string[]): Promise<void> {
  const shape = VARIANTS[variant];
  if (shape === undefined) throw new Error(`unknown variant ${variant}; one of ${Object.keys(VARIANTS).join(", ")}`);
  const qs = questions(ids);
  const done = readJsonl<SearchRecord>(SEARCH_LOG).filter((r) => r.status === 200).length;
  if (done + qs.length > MAX_SEARCH_CALLS) throw new Error(`spend guard: ${done} searches done, ${qs.length} more exceeds ${MAX_SEARCH_CALLS}`);
  mkdirSync(RAW, { recursive: true });
  for (const [i, q] of qs.entries()) {
    if (i > 0) await sleep(PACE_MS);
    const body = { ...shape(q.query), limit: LIMIT, sources: ["web"], timeout: 30_000 };
    let rec: SearchRecord;
    try {
      const { status, ms, json } = await call("POST", "/search", body);
      const j = json as {
        success?: boolean;
        creditsUsed?: number;
        error?: string;
        data?: { web?: { url: string; title?: string; description?: string }[] };
      } | null;
      const web = j?.data?.web ?? [];
      rec = {
        variant,
        id: q.id,
        query: q.query,
        body,
        ms,
        status,
        creditsUsed: j?.creditsUsed ?? null,
        error: j?.success === true ? null : (j?.error ?? `status ${status}`),
        hits: web.map((h, i) => ({
          pos: i + 1,
          url: h.url,
          title: h.title ?? "",
          description: h.description ?? "",
          inScope: inScope(h.url),
          category: categorize(h.url),
        })),
      };
    } catch (err) {
      rec = { variant, id: q.id, query: q.query, body, ms: -1, status: 0, creditsUsed: null, error: (err as Error).name, hits: [] };
    }
    appendFileSync(SEARCH_LOG, `${JSON.stringify(rec)}\n`);
    const kept = rec.hits.filter((h) => h.inScope).length;
    console.log(`${variant} ${q.id} ${rec.ms}ms credits=${rec.creditsUsed} hits=${rec.hits.length} inScope=${kept}${rec.error ? ` error=${rec.error}` : ""}`);
  }
}

interface FetchRecord {
  variant: string;
  id: string;
  url: string;
  ms: number;
  status: number;
  creditsUsed: number | null;
  error: string | null;
  finalUrl: string | null;
  finalInScope: boolean | null;
  chars: number;
  markdown: string;
}

async function fetchTop(variant: string, ids: string[]): Promise<void> {
  const searches = readJsonl<SearchRecord>(SEARCH_LOG).filter((r) => r.variant === variant);
  const qs = questions(ids);
  const done = readJsonl<FetchRecord>(FETCH_LOG).filter((r) => r.status === 200).length;
  if (done + qs.length > MAX_FETCH_CALLS) throw new Error(`spend guard: ${done} fetches done, ${qs.length} more exceeds ${MAX_FETCH_CALLS}`);
  for (const [i, q] of qs.entries()) {
    if (i > 0) await sleep(PACE_MS);
    const rec = searches.filter((r) => r.id === q.id && r.status === 200).at(-1);
    const top = rec?.hits.find((h) => h.inScope);
    if (top === undefined) {
      console.log(`${q.id}: no in-scope hit for ${variant}; skipped`);
      continue;
    }
    const { status, ms, json } = await call("POST", "/scrape", { url: top.url, formats: ["markdown"], onlyMainContent: true, timeout: 30_000 });
    const j = json as {
      success?: boolean;
      error?: string;
      data?: { markdown?: string; metadata?: { url?: string; creditsUsed?: number; statusCode?: number } };
    } | null;
    const markdown = j?.data?.markdown ?? "";
    const finalUrl = j?.data?.metadata?.url ?? null;
    const out: FetchRecord = {
      variant,
      id: q.id,
      url: top.url,
      ms,
      status,
      creditsUsed: j?.data?.metadata?.creditsUsed ?? null,
      error: j?.success === true ? null : (j?.error ?? `status ${status}`),
      finalUrl,
      finalInScope: finalUrl === null ? null : inScope(finalUrl),
      chars: markdown.length,
      markdown,
    };
    appendFileSync(FETCH_LOG, `${JSON.stringify(out)}\n`);
    console.log(`fetch ${q.id} ${ms}ms credits=${out.creditsUsed} chars=${out.chars} finalInScope=${out.finalInScope}${out.error ? ` error=${out.error}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/** Case-insensitive position of the first expected term in `text`, or -1. */
function firstMatch(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  const found = terms.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0);
  return found.length === 0 ? -1 : Math.min(...found);
}

/** Markdown without images, link targets, or `<br>`, with single spaces: what a leaner fetch could return. */
function plain(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\((?:[^()\s]|\([^)]*\))*(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const WOWHEAD_FLAVORS = new Set(["tbc", "wotlk", "cata", "mop-classic", "forever", "classic-ptr", "ptr", "ptr-2", "beta"]);

/** Category groups for the per-variant counts. */
function group(category: string, inScope: boolean): string {
  if (inScope) return category === "wowhead-classic-locale" ? "in:locale" : category.startsWith("wowhead-classic-") ? "in:wowhead-classic-other" : `in:${category}`;
  if (category === "wowhead-retail") return "out:wowhead-retail";
  if (category.startsWith("wowhead-/")) return WOWHEAD_FLAVORS.has(category.slice("wowhead-/".length)) ? "out:wowhead-other-flavor" : "out:wowhead-other-path";
  if (category.startsWith("other:")) return "out:off-site";
  return `out:${category}`;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length === 0 ? 0 : s.length % 2 === 1 ? (s[m] ?? 0) : Math.round(((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2);
}

function summarize(): void {
  const qs = questions([]);
  const byId = new Map(qs.map((q) => [q.id, q]));
  const allSearches = readJsonl<SearchRecord>(SEARCH_LOG);
  const allFetches = readJsonl<FetchRecord>(FETCH_LOG);
  // The last successful record per (variant, id). Refused calls (429) are counted, not shown.
  // Categories and scope are recomputed from the URL, so a change to either applies to old runs.
  const searches = [...new Map(allSearches.filter((r) => r.status === 200).map((r) => [`${r.variant}/${r.id}`, r])).values()].map((r) => ({
    ...r,
    hits: r.hits.map((h) => ({ ...h, inScope: inScope(h.url), category: categorize(h.url) })),
  }));
  const fetches = [...new Map(allFetches.filter((r) => r.status === 200).map((r) => [`${r.variant}/${r.id}`, r])).values()];
  const searchRows = searches.map((r) => {
    const q = byId.get(r.id);
    const kept = r.hits.filter((h) => h.inScope);
    return {
      variant: r.variant,
      id: r.id,
      query: r.body["query"],
      ...(r.body["includeDomains"] === undefined ? {} : { includeDomains: r.body["includeDomains"] }),
      ms: r.ms,
      credits: r.creditsUsed,
      hits: r.hits.length,
      inScope: kept.length,
      firstInScopePos: kept[0]?.pos ?? null,
      offSite: r.hits.filter((h) => h.category.startsWith("other:")).length,
      // The five hits the tool would return. `hint`: an expected answer term is in the title or snippet. A hint, not the grade.
      top: kept.slice(0, 5).map((h) => `${h.pos} ${h.category} ${q !== undefined && firstMatch(`${h.title} ${h.description}`, q.expect) >= 0 ? "hint" : "-"} ${h.url}`),
      dropped: r.hits.filter((h) => !h.inScope).map((h) => `${h.pos} ${h.category} ${h.url}`),
    };
  });
  const byVariant: Record<string, Record<string, number>> = {};
  for (const r of searches) {
    const v = (byVariant[r.variant] ??= {});
    v["calls"] = (v["calls"] ?? 0) + 1;
    v["hits"] = (v["hits"] ?? 0) + r.hits.length;
    v["inScope"] = (v["inScope"] ?? 0) + r.hits.filter((h) => h.inScope).length;
    v["queriesWithOffSite"] = (v["queriesWithOffSite"] ?? 0) + (r.hits.some((h) => h.category.startsWith("other:")) ? 1 : 0);
    v["queriesWithAtMost2InScope"] = (v["queriesWithAtMost2InScope"] ?? 0) + (r.hits.filter((h) => h.inScope).length <= 2 ? 1 : 0);
    v["queriesWithInScopeFirst"] = (v["queriesWithInScopeFirst"] ?? 0) + (r.hits[0]?.inScope === true ? 1 : 0);
    for (const h of r.hits) {
      const g = group(h.category, h.inScope);
      v[g] = (v[g] ?? 0) + 1;
    }
  }
  for (const [variant, v] of Object.entries(byVariant)) {
    const ms = searches.filter((r) => r.variant === variant).map((r) => r.ms);
    v["msMedian"] = median(ms);
    v["msMax"] = Math.max(...ms);
  }
  const fetchRows = fetches.map((f) => {
    const q = byId.get(f.id);
    const text = plain(f.markdown);
    const at = q === undefined ? -1 : firstMatch(f.markdown, q.expect);
    const atPlain = q === undefined ? -1 : firstMatch(text, q.expect);
    return {
      id: f.id,
      url: f.url,
      ms: f.ms,
      credits: f.creditsUsed,
      finalInScope: f.finalInScope,
      chars: f.chars,
      expectAt: at,
      charsPlain: text.length,
      expectAtPlain: atPlain,
    };
  });
  const totals = {
    refusedCalls: [...allSearches, ...allFetches].filter((r) => r.status !== 200).length,
    searchCalls: searches.length,
    searchCredits: searches.reduce((s, r) => s + (r.creditsUsed ?? 0), 0),
    fetchCalls: fetches.length,
    fetchCredits: fetches.reduce((s, r) => s + (r.creditsUsed ?? 0), 0),
  };
  // One row per line: small, and readable in a diff.
  const lines = (rows: unknown[]) => rows.map((row) => `    ${JSON.stringify(row)}`).join(",\n");
  const out = [
    "{",
    `  "limit": ${LIMIT},`,
    `  "prefixes": ${JSON.stringify(PREFIXES)},`,
    `  "fetchTruncate": ${FETCH_TRUNCATE},`,
    `  "totals": ${JSON.stringify(totals)},`,
    `  "byVariant": {\n${Object.entries(byVariant).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n")}\n  },`,
    `  "searches": [\n${lines(searchRows)}\n  ],`,
    `  "fetches": [\n${lines(fetchRows)}\n  ]`,
    "}",
  ];
  writeFileSync(join(HERE, "results.json"), `${out.join("\n")}\n`);
  console.log(JSON.stringify(totals));
}

// ---------------------------------------------------------------------------

const [cmd, arg, ...rest] = process.argv.slice(2);
if (cmd === "credits") await credits();
else if (cmd === "search" && arg !== undefined) await search(arg, rest);
else if (cmd === "fetch" && arg !== undefined) await fetchTop(arg, rest);
else if (cmd === "summarize") summarize();
else {
  console.error("usage: run.ts credits | search <variant> [ids...] | fetch <variant> [ids...] | summarize");
  process.exitCode = 2;
}
