import type { Pool } from "pg";

import { failureCode } from "./db.js";
import { logger } from "./log.js";
import { MAX_PAGE_SOURCE, type Page, type PageFetch } from "./pages.js";
import { inScope, MAX_RESULTS, MAX_URL, type ScopedSearch, type SearchHit } from "./search.js";

/**
 * The shared search and page cache (§12), on the `search_cache` table
 * (migration 0008). It is shared across users and linked to none (§11).
 *
 * `cachedSearch` and `cachedPageFetch` wrap a `ScopedSearch` and a
 * `PageFetch`. A call whose key has a row that has not expired answers from
 * the row, and Firecrawl is not called. Any other call goes to the wrapped
 * function, and its answer is stored when it succeeded:
 *
 * - A search is keyed by `(kit, flavor, scope_hash, normalized_query)`. Its
 *   row holds the hits in scope after the post-filter. A provider failure
 *   (`search_unavailable`) throws and stores nothing, and a scope with no
 *   prefixes (`no_sources`) is never stored.
 * - A page is keyed by its URL without the fragment (`pageKey`). Its row holds
 *   the final URL and the stripped text. A page with a 4xx or 5xx status, 404
 *   included, is not stored, and neither is one whose final URL is longer
 *   than any URL in scope can be.
 * - An empty answer, a search with no hit in scope or a page with no text,
 *   stays for `emptyTtlMs` instead of `ttlMs` (S3,
 *   docs/spikes/s3-firecrawl-scoping.md): the sources may have it later.
 *
 * `scope_hash` changes when a manifest's scope does (`searchScope`), so the
 * old rows are no longer read and expire.
 *
 * Two identical misses at once both call Firecrawl, and both write: the write
 * is an upsert, so neither fails. Each write then deletes up to
 * `CLEANUP_BATCH` expired rows. Every row is written once and expires once,
 * so that keeps up with the rows that expire.
 *
 * The cache is an optimization. A failed read or write is logged with its
 * code and the call goes on without it. A row that no longer has the shape
 * this code writes is a miss, and a cached hit is checked against the scope
 * again. No log line holds a query or a URL: the line carries the user's
 * uuid.
 *
 * Adapted from `cloud/src/postgresSearchCache.ts` in bttf/wow-guide@df80260,
 * with the §12 keys, `expires_at` set on write, and a bounded cleanup in
 * place of the row cap.
 */

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** The cache's lifetimes (*proposed*, §0). `config.ts` reads them from the environment. */
export interface SearchCacheSettings {
  /** `SEARCH_CACHE_TTL_DAYS`: how long a search or page stays in the cache (§12). */
  ttlMs: number;
  /** `SEARCH_CACHE_EMPTY_TTL_MINUTES`: how long an empty answer stays: a search with no hit in scope, or a page with no text. */
  emptyTtlMs: number;
}

export const DEFAULT_SEARCH_CACHE: SearchCacheSettings = { ttlMs: 7 * DAY_MS, emptyTtlMs: 60 * MINUTE_MS };

/** The most expired rows one write deletes. */
export const CLEANUP_BATCH = 100;

export interface SearchCacheOptions {
  pool: Pool;
  /** Default: `DEFAULT_SEARCH_CACHE`. */
  settings?: SearchCacheSettings;
  /** Default: the system clock. Tests pass their own. */
  now?: () => Date;
}

/** `search`, answered from the cache when it can be. */
export function cachedSearch(search: ScopedSearch, options: SearchCacheOptions): ScopedSearch {
  const cache = new Cache(options);
  return async (scope, query) => {
    if (scope.prefixes.length === 0) return search(scope, query);
    const key = [scope.kit, scope.flavor, scope.hash, query];
    const cached = searchHits(await cache.get("search", key));
    if (cached !== null) {
      // RED-336: set usage.cacheHit = true and usage.searchCredits = 0 here, and usage.cacheHit = false on a miss.
      const hits = cached.filter((hit) => inScope(hit.url, scope.prefixes) === hit.url).slice(0, MAX_RESULTS);
      logger.info("search cache hit", { kit: scope.kit, flavor: scope.flavor, in_scope: hits.length });
      return hits;
    }
    const hits = await search(scope, query);
    await cache.put("search", key, hits, hits.length === 0);
    return hits;
  };
}

/** `fetchPage`, answered from the cache when it can be. */
export function cachedPageFetch(fetchPage: PageFetch, options: SearchCacheOptions): PageFetch {
  const cache = new Cache(options);
  return async (url) => {
    const key = [url];
    const cached = page(await cache.get("page", key));
    if (cached !== null) {
      logger.info("page cache hit", { chars: cached.markdown.length });
      return cached;
    }
    const fetched = await fetchPage(url);
    const failed = fetched.status !== undefined && fetched.status >= 400;
    if (!failed && fetched.url.length <= MAX_URL) await cache.put("page", key, fetched, fetched.markdown === "");
    return fetched;
  };
}

type Kind = "search" | "page";

/**
 * The statements of each kind. `get` takes the time, then the key; `put` takes
 * the time, the expiry, and the payload's JSON, then the key.
 */
const STATEMENTS: Readonly<Record<Kind, { get: string; put: string }>> = {
  search: {
    get: `select payload from search_cache
          where kind = 'search' and kit = $2 and flavor = $3 and scope_hash = $4 and normalized_query = $5 and expires_at > $1`,
    put: `insert into search_cache (kind, fetched_at, expires_at, payload, kit, flavor, scope_hash, normalized_query)
          values ('search', $1, $2, $3::jsonb, $4, $5, $6, $7)
          on conflict on constraint search_cache_search
          do update set payload = excluded.payload, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
  },
  page: {
    get: `select payload from search_cache where kind = 'page' and url = $2 and expires_at > $1`,
    put: `insert into search_cache (kind, fetched_at, expires_at, payload, url)
          values ('page', $1, $2, $3::jsonb, $4)
          on conflict on constraint search_cache_page
          do update set payload = excluded.payload, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
  },
};

/** Up to `CLEANUP_BATCH` expired rows. Skip locked: a concurrent write's cleanup takes other rows instead of waiting. */
const CLEANUP = `delete from search_cache where id in (
  select id from search_cache where expires_at <= $1 order by expires_at limit $2 for update skip locked
)`;

/** Reads and writes `search_cache` rows. */
class Cache {
  private readonly pool: Pool;
  private readonly settings: SearchCacheSettings;
  private readonly now: () => Date;

  constructor({ pool, settings = DEFAULT_SEARCH_CACHE, now = () => new Date() }: SearchCacheOptions) {
    this.pool = pool;
    this.settings = settings;
    this.now = now;
  }

  /** The payload of the row of `kind` with `key` that has not expired, or null. Null on a failure too. */
  async get(kind: Kind, key: readonly string[]): Promise<unknown> {
    try {
      const { rows } = await this.pool.query<{ payload: unknown }>(STATEMENTS[kind].get, [this.now(), ...key]);
      return rows[0]?.payload ?? null;
    } catch (err) {
      logger.warn("search cache read failed", { kind, code: failureCode(err) });
      return null;
    }
  }

  /**
   * Stores `payload` as the row of `kind` with `key`, replacing one that is
   * there, then deletes up to `CLEANUP_BATCH` expired rows. An `empty` answer
   * gets the shorter lifetime.
   */
  async put(kind: Kind, key: readonly string[], payload: unknown, empty: boolean): Promise<void> {
    const now = this.now();
    const expiresAt = new Date(now.getTime() + (empty ? this.settings.emptyTtlMs : this.settings.ttlMs));
    try {
      await this.pool.query(STATEMENTS[kind].put, [now, expiresAt, JSON.stringify(payload), ...key]);
      await this.pool.query(CLEANUP, [now, CLEANUP_BATCH]);
    } catch (err) {
      logger.warn("search cache write failed", { kind, code: failureCode(err) });
    }
  }
}

/** A search row's payload as hits, or null when it is not a list of them. */
function searchHits(payload: unknown): SearchHit[] | null {
  if (!Array.isArray(payload)) return null;
  const hits: SearchHit[] = [];
  for (const item of payload as unknown[]) {
    if (!isObject(item)) return null;
    const { title, url, excerpt } = item;
    if (typeof title !== "string" || typeof url !== "string" || typeof excerpt !== "string") return null;
    hits.push({ title, url, excerpt });
  }
  return hits;
}

/** A page row's payload as a `Page`, or null when it is not one. */
function page(payload: unknown): Page | null {
  if (!isObject(payload)) return null;
  const { url, markdown, cut, status } = payload;
  if (typeof url !== "string" || typeof markdown !== "string" || markdown.length > MAX_PAGE_SOURCE || typeof cut !== "boolean") return null;
  if (status !== undefined && typeof status !== "number") return null;
  return { url, markdown, cut, ...(status !== undefined && { status }) };
}

function isObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
