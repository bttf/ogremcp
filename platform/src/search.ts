import { createHash } from "node:crypto";

import { failureLevel, FirecrawlError, type FirecrawlHit, type FirecrawlOptions, firecrawlSearch } from "./firecrawl.js";
import { logger } from "./log.js";

/**
 * Game-scoped search (§12), behind the `search_game_info` tool
 * (`search-game-info.ts`).
 *
 * A search covers one scope: the URL prefixes of one flavor of one kit, from
 * the manifest's `flavors.<key>.search` (§6.1). Firecrawl gets the query with
 * the scope's `site:` terms (`providerQuery`). Those only steer its ranking:
 * S3 found that Firecrawl ignores them for about half the queries
 * (docs/spikes/s3-firecrawl-scoping.md). The URL-prefix post-filter
 * (`inScope`) is what guarantees the scope.
 *
 * `ScopedSearch` is the one call to the provider. Its inputs are the search
 * cache's key (§12): the scope's kit, flavor, and hash, and the normalized
 * query. The request is made from them alone, and the answer is the
 * post-filtered hits, so the shared cache can wrap it and store them
 * (RED-335).
 *
 * The post-filter, `normalizeQuery`, `clip`, and `plainText` are adapted from
 * `allowedUrl()`, `selectHits()`, `normalizeQuery()`, `clip()`, and
 * `plainText()` in `cloud/src/search.ts` in bttf/wow-guide@df80260.
 */

/** Hits a search returns. */
export const MAX_RESULTS = 5;
/** Hits asked of Firecrawl. 1 to 10 cost the same 2 credits, and the post-filter drops some (S3). */
export const PROVIDER_LIMIT = 10;
/** Longest query, in characters, after `normalizeQuery`. */
export const MAX_QUERY = 200;
/** Longest title and excerpt of a hit, in characters. */
export const MAX_TITLE = 200;
export const MAX_EXCERPT = 800;
/** Longest URL of a hit, in characters. A longer one drops the hit: a cut URL would be wrong. */
export const MAX_URL = 500;
/**
 * Longest snippet `plainText` reads, in characters. A snippet is cut to it
 * first: some of `plainText`'s patterns take time quadratic in their input.
 */
export const MAX_SNIPPET = 4000;

/** What one search covers: one flavor of one kit. */
export interface SearchScope {
  /** The manifest's `kit`, e.g. `wow`. */
  kit: string;
  /** A key of the manifest's `flavors`. */
  flavor: string;
  /** The flavor's `search` URL prefixes, as the URL parser writes them. */
  prefixes: readonly string[];
  /**
   * `scope_hash` (§12): SHA-256, in hex, of the prefixes, the query
   * template, and the limit. A change to any of them changes the hash, so
   * the cache's old rows for the scope age out.
   */
  hash: string;
}

/** A search hit as the tool returns it. Its text comes from a web page: untrusted (§10.5). */
export interface SearchHit {
  title: string;
  url: string;
  excerpt: string;
}

/**
 * Searches `scope` for `query`, a `normalizeQuery` result. Answers the hits
 * in scope, at most `MAX_RESULTS`. Throws a `FirecrawlError` when the
 * provider fails.
 */
export type ScopedSearch = (scope: SearchScope, query: string) => Promise<SearchHit[]>;

/** The scope of `flavor` of `kit`, from the flavor's `search` prefixes. A prefix that does not parse is left out: no URL could match it. */
export function searchScope(kit: string, flavor: string, prefixes: readonly string[]): SearchScope {
  const parsed = prefixes.flatMap((prefix) => URL.parse(prefix)?.href ?? []);
  const input = JSON.stringify({ prefixes: parsed, template: providerQuery("{query}", parsed), limit: PROVIDER_LIMIT });
  return { kit, flavor, prefixes: parsed, hash: createHash("sha256").update(input).digest("hex") };
}

/** A query in the cache key's form (S3): NFKC, lower case, single spaces, and trimmed. */
export function normalizeQuery(query: string): string {
  return query.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** A prefix's `site:` term (S3): the host without `www.`, then the path without its trailing slash. */
function siteTerm(prefix: string): string {
  const url = new URL(prefix);
  return `site:${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`;
}

/** What Firecrawl is asked (S3): the query, then the scope's `site:` terms, e.g. `hogger (site:wowhead.com/classic OR site:warcraft.wiki.gg)`. */
export function providerQuery(query: string, prefixes: readonly string[]): string {
  return `${query} (${[...new Set(prefixes.map(siteTerm))].join(" OR ")})`;
}

/**
 * The post-filter (§12), shared by search and page fetches. The URL as the
 * parser writes it (`href`) when it parses, is https, has no credentials or
 * port, has a path that cannot name another path (`escapesPath`), is at most
 * `MAX_URL` characters, and starts with one of `prefixes`; null otherwise.
 * Each prefix is https with a path that ends in `/` (the manifest schema), so
 * a host or path segment that only starts with a prefix's does not match. The
 * `href` is what the tool returns: the parser drops tabs and line breaks that
 * the raw URL can hold.
 */
export function inScope(url: string, prefixes: readonly string[]): string | null {
  const parsed = URL.parse(url);
  if (parsed === null || parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.port !== "") return null;
  if (escapesPath(parsed.pathname)) return null;
  const { href } = parsed;
  return href.length <= MAX_URL && prefixes.some((prefix) => href.startsWith(prefix)) ? href : null;
}

/**
 * Whether a parsed path could name a path outside its prefix on a server that
 * decodes it before it resolves `..`: an encoded `/` or `\` (`%2f`, `%5c`),
 * a segment that decodes to `..`, or an encoding that does not decode. The
 * parser has already resolved the literal `..` segments.
 */
function escapesPath(pathname: string): boolean {
  if (/%2f|%5c/i.test(pathname)) return true;
  return pathname.split("/").some((segment) => {
    try {
      return decodeURIComponent(segment) === "..";
    } catch {
      return true;
    }
  });
}

/** The hits in scope, in Firecrawl's order, one per URL, with plain text cut to length. */
export function selectHits(hits: readonly FirecrawlHit[], prefixes: readonly string[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const hit of hits) {
    const url = inScope(hit.url, prefixes);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    const title = clip((hit.title ?? "").replace(/\s+/g, " ").trim(), MAX_TITLE);
    out.push({ title: title === "" ? url : title, url, excerpt: clip(plainText((hit.description ?? "").slice(0, MAX_SNIPPET)), MAX_EXCERPT) });
  }
  return out;
}

/** Cuts `text` to `max` characters at a word boundary, ending in an ellipsis. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * A snippet as plain text: no images, link targets, footnote links, HTML
 * tags, escapes, heading marks, or emphasis, and single spaces.
 */
export function plainText(snippet: string): string {
  return (
    snippet
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      // Footnote links, `[\[2\]](...#cite_note-2)`.
      .replace(/\[\\\[[^\]]*\\\]\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\((?:[^()\s]|\([^)]*\))*(?:\s+"[^"]*")?\)/g, "$1")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/?[A-Za-z][^>]*>/g, "")
      .replace(/\\([\\`*_{}[\]()#+\-.!|<>])/g, "$1")
      .replace(/^\s*#{1,6}\s*/gm, "")
      .replace(/\*\*|__|`/g, "")
      .replace(/(?:\s*\|)+\s*/g, " | ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * The `ScopedSearch` on Firecrawl: one request per call. Each call writes one
 * log line with the kit, flavor, hit counts, and time, or the failure's
 * reason and status. Never the query: the line carries the user's uuid, and
 * a query can hold a character's name.
 */
export function firecrawlScopedSearch(options: FirecrawlOptions): ScopedSearch {
  return async (scope, query) => {
    const started = performance.now();
    const fields = { kit: scope.kit, flavor: scope.flavor };
    let hits: FirecrawlHit[];
    try {
      hits = await firecrawlSearch(options, providerQuery(query, scope.prefixes), PROVIDER_LIMIT);
    } catch (err) {
      if (err instanceof FirecrawlError) {
        logger[failureLevel(err)]("search failed", { ...fields, reason: err.reason, status: err.status, duration_ms: since(started) });
      }
      throw err;
    }
    const selected = selectHits(hits, scope.prefixes);
    logger.info("search", { ...fields, hits: hits.length, in_scope: selected.length, duration_ms: since(started) });
    return selected.slice(0, MAX_RESULTS);
  };
}

function since(started: number): number {
  return Math.round(performance.now() - started);
}
