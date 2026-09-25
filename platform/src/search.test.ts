import { afterEach, describe, expect, it } from "vitest";

import { FIRECRAWL_SEARCH_URL } from "./firecrawl.js";
import { configureLogger } from "./log.js";
import { firecrawlScopedSearch, inScope, MAX_EXCERPT, MAX_RESULTS, searchScope, selectHits } from "./search.js";

// The Classic Era scope of kits/wow/manifest.json.
const PREFIXES = ["https://www.wowhead.com/classic/", "https://warcraft.wiki.gg/"];
const SCOPE = searchScope("wow", "classic_era", PREFIXES);

afterEach(() => configureLogger({ write: () => {} }));

describe("inScope (§12)", () => {
  it("keeps https URLs under a prefix, and drops every other form", () => {
    expect(inScope("https://www.wowhead.com/classic/npc=448/hogger", PREFIXES)).toBe("https://www.wowhead.com/classic/npc=448/hogger");
    expect(inScope("https://warcraft.wiki.gg/wiki/Hogger", PREFIXES)).toBe("https://warcraft.wiki.gg/wiki/Hogger");
    // The parser's form: host in lower case, tabs and line breaks gone.
    expect(inScope("https://WWW.WOWHEAD.COM/classic/npc=448\n", PREFIXES)).toBe("https://www.wowhead.com/classic/npc=448");

    for (const url of [
      "https://www.wowhead.com.evil.com/classic/npc=448",
      "https://warcraft.wiki.gg.evil.com/wiki/Hogger",
      "https://www.wowhead.com/classic-ptr/npc=448",
      "https://www.wowhead.com/classic/../tbc/npc=448",
      "https://www.wowhead.com/tbc/npc=448",
      "https://www.wowhead.com/npc=448",
      "https://wowhead.com/classic/npc=448",
      "http://www.wowhead.com/classic/npc=448",
      "https://user:pass@www.wowhead.com/classic/npc=448",
      "https://www.wowhead.com:8443/classic/npc=448",
      `https://www.wowhead.com/classic/${"a".repeat(500)}`,
      "https://www.youtube.com/watch?v=hogger",
      "not a url",
    ]) {
      expect(inScope(url, PREFIXES), url).toBeNull();
    }
  });
});

describe("inScope's path check", () => {
  it("drops a path that a server decoding before it resolves .. would read as another path", () => {
    for (const url of [
      "https://www.wowhead.com/classic/..%2ftbc/npc=448",
      "https://www.wowhead.com/classic/..%2Ftbc/npc=448",
      "https://www.wowhead.com/classic/..%5ctbc/npc=448",
      "https://warcraft.wiki.gg/wiki/%E0%A4%A",
    ]) {
      expect(inScope(url, PREFIXES), url).toBeNull();
    }
    expect(inScope("https://warcraft.wiki.gg/wiki/Wanted:_%22Hogger%22", PREFIXES)).toBe("https://warcraft.wiki.gg/wiki/Wanted:_%22Hogger%22");
  });
});

describe("selectHits", () => {
  it("cuts a long snippet before making it plain text, so a pathological one stays fast", () => {
    const started = performance.now();
    const [hit] = selectHits([{ url: "https://warcraft.wiki.gg/wiki/Hogger", description: "![".repeat(40_000) }], PREFIXES);
    expect(performance.now() - started).toBeLessThan(250);
    expect(hit?.excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT);
  });
});

describe("searchScope", () => {
  it("hashes the prefixes, so that a scope change gives a new scope_hash", () => {
    expect(SCOPE.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(searchScope("wow", "forever", PREFIXES).hash).toBe(SCOPE.hash);
    expect(searchScope("wow", "classic_era", PREFIXES.slice(1)).hash).not.toBe(SCOPE.hash);
  });
});

/** A `fetch` that answers each call with `answer`, and the calls it got. */
function stubFetch(answer: (init: RequestInit) => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer(init);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function hit(url: string, n: number) {
  return { url, title: `Title ${n}`, description: `[Snippet](https://elsewhere.example/) ${n}`, position: n };
}

describe("firecrawlScopedSearch", () => {
  it("sends the S3 request, and returns the hits in scope, at most MAX_RESULTS", async () => {
    const web = [
      hit("https://www.youtube.com/watch?v=hogger", 1),
      hit("https://www.wowhead.com/classic/npc=448/hogger", 2),
      hit("https://www.wowhead.com.evil.com/classic/npc=448", 3),
      hit("https://www.wowhead.com/classic-ptr/npc=448", 4),
      ...[5, 6, 7, 8, 9, 10].map((n) => hit(`https://warcraft.wiki.gg/wiki/Page_${n}`, n)),
    ];
    const { fetch, calls } = stubFetch(async () => Response.json({ success: true, data: { web } }));
    const lines: string[] = [];
    configureLogger({ write: (line) => lines.push(line) });

    const hits = await firecrawlScopedSearch({ apiKey: "test-key", timeoutMs: 5000, fetch })(SCOPE, "hogger elwynn");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(FIRECRAWL_SEARCH_URL);
    expect(calls[0]?.init.method).toBe("POST");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer test-key");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      query: "hogger elwynn (site:wowhead.com/classic OR site:warcraft.wiki.gg)",
      limit: 10,
      sources: ["web"],
      timeout: 4000,
    });
    expect(hits).toHaveLength(MAX_RESULTS);
    expect(hits[0]).toEqual({ title: "Title 2", url: "https://www.wowhead.com/classic/npc=448/hogger", excerpt: "Snippet 2" });
    expect(hits.map((h) => h.url).slice(1)).toEqual([5, 6, 7, 8].map((n) => `https://warcraft.wiki.gg/wiki/Page_${n}`));
    // Counts, never the query: the line carries the user's uuid.
    expect(lines.map((line) => JSON.parse(line) as unknown)).toMatchObject([{ level: "info", msg: "search", kit: "wow", flavor: "classic_era", hits: 10, in_scope: 7 }]);
    expect(lines.join("\n")).not.toContain("hogger");
  });

  it("fails with a FirecrawlError on a 429 and on a timeout, and logs neither the query nor the key", async () => {
    const lines: string[] = [];
    configureLogger({ write: (line) => lines.push(line) });
    const limited = stubFetch(async () => new Response('{"success":false,"error":"Rate limit exceeded"}', { status: 429 }));
    const search429 = firecrawlScopedSearch({ apiKey: "test-key", timeoutMs: 5000, fetch: limited.fetch });
    await expect(search429(SCOPE, "hogger")).rejects.toMatchObject({ name: "FirecrawlError", reason: "http", status: 429 });

    const slow = stubFetch(
      (init) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error))),
    );
    const searchSlow = firecrawlScopedSearch({ apiKey: "test-key", timeoutMs: 20, fetch: slow.fetch });
    await expect(searchSlow(SCOPE, "hogger")).rejects.toMatchObject({ name: "FirecrawlError", reason: "timeout" });

    expect(lines.map((line) => JSON.parse(line) as unknown)).toMatchObject([
      { level: "warn", msg: "search failed", reason: "http", status: 429 },
      { level: "warn", msg: "search failed", reason: "timeout" },
    ]);
    expect(lines.join("\n")).not.toMatch(/hogger|test-key/);
  });
});
