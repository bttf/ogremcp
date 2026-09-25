import { randomBytes } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPool } from "./db.js";
import { FirecrawlError } from "./firecrawl.js";
import { configureLogger } from "./log.js";
import { migrate } from "./migrations.js";
import type { Page, PageFetch } from "./pages.js";
import { type ScopedSearch, type SearchHit, searchScope } from "./search.js";
import { cachedPageFetch, cachedSearch, DEFAULT_SEARCH_CACHE } from "./search-cache.js";

/** As in migrations.test.ts: a Postgres server whose user may create databases. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"]?.trim() || undefined;
if (TEST_DATABASE_URL === undefined) console.warn("TEST_DATABASE_URL is not set: the Postgres tests in search-cache.test.ts are skipped");

const DAY_MS = 24 * 60 * 60 * 1000;
const SCOPE = searchScope("wow", "classic_era", ["https://www.wowhead.com/classic/", "https://warcraft.wiki.gg/"]);
const HIT: SearchHit = { title: "Hogger - NPC", url: "https://www.wowhead.com/classic/npc=448/hogger", excerpt: "Found in Elwynn Forest." };
const PAGE: Page = { url: "https://www.wowhead.com/classic/npc=448/hogger", markdown: "# Hogger\n\nFound in Elwynn Forest.", cut: false, status: 200 };

describe.skipIf(TEST_DATABASE_URL === undefined)("the shared search cache (§12)", () => {
  const name = `ogmcp_test_${randomBytes(6).toString("hex")}`;
  let admin: Pool;
  let pool: Pool;
  let now: Date;
  const clock = () => now;

  beforeAll(async () => {
    admin = createPool({ url: TEST_DATABASE_URL ?? "", queryTimeoutMs: 10_000, max: 1 });
    await admin.query(`create database "${name}"`);
    const url = new URL(TEST_DATABASE_URL ?? "");
    url.pathname = `/${name}`;
    pool = createPool({ url: url.toString(), queryTimeoutMs: 10_000, max: 4 });
    await migrate(pool);
  });

  afterAll(async () => {
    await pool?.end();
    try {
      await admin.query(`drop database if exists "${name}" with (force)`);
    } finally {
      await admin.end();
    }
  });

  beforeEach(async () => {
    now = new Date(Date.UTC(2026, 8, 25));
    await pool.query("truncate search_cache");
  });

  /** A `ScopedSearch` that answers `answer` for each call, and the calls it got. */
  function stubSearch(...answers: (SearchHit[] | Error)[]): { search: ScopedSearch; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      search: async (scope, query) => {
        calls.push(`${scope.hash} ${query}`);
        const answer = answers[Math.min(calls.length, answers.length) - 1] ?? [];
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
  }

  function stubFetch(...answers: Page[]): { fetchPage: PageFetch; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      fetchPage: async (url) => {
        calls.push(url);
        return answers[Math.min(calls.length, answers.length) - 1] ?? PAGE;
      },
    };
  }

  async function rows(): Promise<number> {
    const { rows } = await pool.query<{ n: number }>("select count(*)::int as n from search_cache");
    return rows[0]?.n ?? 0;
  }

  it("answers a second identical search from the cache", async () => {
    const { search, calls } = stubSearch([HIT]);
    const cached = cachedSearch(search, { pool, now: clock });
    expect(await cached(SCOPE, "hogger")).toEqual([HIT]);
    now = new Date(now.getTime() + DEFAULT_SEARCH_CACHE.ttlMs - 1);
    expect(await cached(SCOPE, "hogger")).toEqual([HIT]);
    expect(calls).toHaveLength(1);
  });

  it("misses when the scope changes, and a later write deletes the stale row", async () => {
    const { search, calls } = stubSearch([HIT]);
    const cached = cachedSearch(search, { pool, now: clock });
    await cached(SCOPE, "hogger");
    const changed = searchScope("wow", "classic_era", ["https://www.wowhead.com/classic/"]);
    expect(changed.hash).not.toBe(SCOPE.hash);
    now = new Date(now.getTime() + DEFAULT_SEARCH_CACHE.ttlMs);
    await cached(changed, "hogger");
    expect(calls).toEqual([`${SCOPE.hash} hogger`, `${changed.hash} hogger`]);
    expect(await rows()).toBe(1);
  });

  it("does not serve an expired row, and keeps an empty answer for less time", async () => {
    const { search, calls } = stubSearch([HIT], [], [HIT]);
    const cached = cachedSearch(search, { pool, now: clock });
    await cached(SCOPE, "hogger");
    await cached(SCOPE, "no such mob");
    now = new Date(now.getTime() + DEFAULT_SEARCH_CACHE.emptyTtlMs);
    await cached(SCOPE, "no such mob");
    await cached(SCOPE, "hogger");
    now = new Date(now.getTime() + DEFAULT_SEARCH_CACHE.ttlMs);
    await cached(SCOPE, "hogger");
    expect(calls.map((call) => call.split(" ").slice(1).join(" "))).toEqual(["hogger", "no such mob", "no such mob", "hogger"]);
  });

  it("does not store a failed search", async () => {
    const { search, calls } = stubSearch(new FirecrawlError("http", 429), [HIT]);
    const cached = cachedSearch(search, { pool, now: clock });
    await expect(cached(SCOPE, "hogger")).rejects.toThrow(FirecrawlError);
    expect(await rows()).toBe(0);
    expect(await cached(SCOPE, "hogger")).toEqual([HIT]);
    expect(calls).toHaveLength(2);
  });

  it("answers a page from the cache with the same final URL and text, and does not store a 404", async () => {
    const redirected: Page = { ...PAGE, url: "https://www.wowhead.com/classic/npc=448/hogger-the-gnoll" };
    const { fetchPage, calls } = stubFetch(redirected);
    const cached = cachedPageFetch(fetchPage, { pool, now: clock });
    expect(await cached(PAGE.url)).toEqual(redirected);
    expect(await cached(PAGE.url)).toEqual(redirected);
    expect(calls).toHaveLength(1);

    const missing = "https://warcraft.wiki.gg/wiki/Nowhere";
    const notFound = stubFetch({ ...PAGE, url: missing, status: 404 }, { ...PAGE, url: missing });
    const fetches = cachedPageFetch(notFound.fetchPage, { pool, now: clock });
    expect((await fetches(missing)).status).toBe(404);
    expect((await fetches(missing)).status).toBe(200);
    expect(notFound.calls).toHaveLength(2);
  });

  it("stores two identical misses at once without an error", async () => {
    const search: ScopedSearch = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [HIT];
    };
    const cached = cachedSearch(search, { pool, now: clock });
    const lines: string[] = [];
    configureLogger({ write: (line) => lines.push(line) });
    try {
      expect(await Promise.all([cached(SCOPE, "hogger"), cached(SCOPE, "hogger")])).toEqual([[HIT], [HIT]]);
    } finally {
      configureLogger({ write: () => {} });
    }
    expect(lines.filter((line) => line.includes("search cache write failed"))).toEqual([]);
    expect(await rows()).toBe(1);
  });
});
