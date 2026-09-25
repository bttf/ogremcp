import type { ToolResult } from "@ogmcp/sdk";
import type { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { fetchGamePage } from "./fetch-game-page.js";
import { FIRECRAWL_SCRAPE_URL } from "./firecrawl.js";
import { KIT_SOURCES, type Kit } from "./kits/registry.js";
import { checkKits } from "./kits/validate.js";
import { configureLogger } from "./log.js";
import { firecrawlPageFetch, MAX_PAGE_SOURCE, type PageFetch } from "./pages.js";
import { NOT_ENABLED_MESSAGE, NOT_SET_UP_MESSAGE, UNAVAILABLE_MESSAGE } from "./search-game-info.js";
import { DEFAULT_TOOL_CONTEXT, type ToolContextSettings } from "./tool-context.js";

const [checked] = checkKits(KIT_SOURCES);
const WOW: Kit = { key: "wow", name: "World of Warcraft", manifest: checked!.manifest, interpreter: KIT_SOURCES[0]!.interpreter, adapter: null };
const USER = { id: "1", uuid: "00000000-0000-4000-8000-000000000001", tier: "free" as const };
const HOGGER = "https://www.wowhead.com/classic/npc=448/hogger";

afterEach(() => configureLogger({ write: () => {} }));

/** A Firecrawl scrape answer for a page whose final URL is `url`. */
function scraped(url: string | undefined, markdown: string): Response {
  return Response.json({ success: true, data: { markdown, metadata: { sourceURL: "https://www.wowhead.com/classic/npc=448", url, statusCode: 200 } } });
}

/** The `PageFetch` on a stub Firecrawl that answers every request with `answer()`, and the requests it got. */
function firecrawl(answer: () => Response): { fetchPage: PageFetch; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return answer();
  }) as typeof globalThis.fetch;
  return { calls, fetchPage: firecrawlPageFetch({ apiKey: "test-key", timeoutMs: 5000, fetch }) };
}

/** Calls the tool for `games`, the user's enabled games. */
function call(
  args: unknown,
  fetchPage: PageFetch | null,
  games: readonly Kit[] = [WOW],
  settings: ToolContextSettings = DEFAULT_TOOL_CONTEXT,
): Promise<ToolResult> {
  return fetchGamePage.handler(args, { pool: {} as Pool, user: USER, games, settings, search: null, fetchPage });
}

describe("fetch_game_page (§10.3, §12)", () => {
  it("fetches an in-scope page through Firecrawl, without images and link targets, cut to the limit", async () => {
    const markdown = [
      "# Hogger",
      "[![](https://wow.zamimg.com/uploads/screenshots/small/1.jpg)](https://www.wowhead.com/classic/npc=448/hogger#screenshots)",
      'Found in [Elwynn Forest](https://www.wowhead.com/classic/zone=12/elwynn-forest "Elwynn Forest"), near ![map](https://wow.zamimg.com/map.png)the lake.   ',
      "\n\n",
      "[\\[1\\]](https://warcraft.wiki.gg/wiki/Hogger_(Classic)) Level 11 elite.",
      "[\nLeads the Riverpaw pack.\n](https://warcraft.wiki.gg/wiki/Riverpaw_pack)",
    ].join("\n");
    const { fetchPage, calls } = firecrawl(() => scraped(HOGGER, markdown));
    const lines: string[] = [];
    configureLogger({ write: (line) => lines.push(line) });

    const result = await call({ game: "wow", url: "https://www.wowhead.com/classic/npc=448#comments" }, fetchPage);

    expect(calls).toEqual([
      { url: FIRECRAWL_SCRAPE_URL, body: { url: "https://www.wowhead.com/classic/npc=448", formats: ["markdown"], onlyMainContent: true, timeout: 4000 } },
    ]);
    const page = "# Hogger\n\nFound in Elwynn Forest, near the lake.\n\n\\[1\\] Level 11 elite.\n\nLeads the Riverpaw pack.";
    expect(result.structuredContent).toEqual({ game: "wow", url: HOGGER, truncated: false, markdown: page });
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(result.structuredContent);

    const cut = await call({ game: "wow", url: HOGGER }, fetchPage, [WOW], { ...DEFAULT_TOOL_CONTEXT, fetchPageMaxChars: 30 });
    expect(cut.structuredContent).toEqual({ game: "wow", url: HOGGER, truncated: true, markdown: "# Hogger\n\nFound in Elwynn…" });

    // Codes and sizes, never the URL or the key: the line carries the user's uuid.
    expect(lines.map((line) => JSON.parse(line) as unknown)).toMatchObject([
      { level: "info", msg: "page fetch", status: 200, source_chars: markdown.length, chars: page.length },
      { level: "info", msg: "page fetch" },
    ]);
    expect(lines.join("\n")).not.toMatch(/wowhead|npc=448|test-key/);
  });

  it("cuts Firecrawl's markdown before stripping it, so a pathological page stays fast and is marked truncated", async () => {
    for (const markdown of ["![".repeat(MAX_PAGE_SOURCE), "[a](".repeat(MAX_PAGE_SOURCE / 2), `[x](${"(a)".repeat(MAX_PAGE_SOURCE)}`]) {
      const { fetchPage } = firecrawl(() => scraped(HOGGER, markdown));
      const started = performance.now();
      const result = await call({ game: "wow", url: HOGGER }, fetchPage);
      expect(performance.now() - started).toBeLessThan(250);
      expect(result.structuredContent).toMatchObject({ truncated: true });
    }
  });

  it("refuses a URL outside the game's sources without fetching it, encoded and .. paths included", async () => {
    const { fetchPage, calls } = firecrawl(() => scraped(HOGGER, "# Hogger"));
    for (const url of [
      "https://www.wowhead.com/tbc/npc=448",
      "https://www.wowhead.com/classic/../tbc/npc=448",
      "https://www.wowhead.com/classic/..%2ftbc/npc=448",
      "https://www.wowhead.com/classic/..%5Ctbc/npc=448",
      "https://www.wowhead.com/classic/%2e%2e/tbc/npc=448",
      "https://www.wowhead.com.evil.com/classic/npc=448",
      "http://www.wowhead.com/classic/npc=448",
      "http://169.254.169.254/latest/meta-data/",
      "file:///etc/passwd",
    ]) {
      const result = await call({ game: "wow", url }, fetchPage);
      expect(result, url).toEqual({ isError: true, content: [{ type: "text", text: expect.stringMatching(/^That URL is not in World of Warcraft's vetted sources/) }] });
    }
    expect(calls).toEqual([]);
  });

  it("refuses a page whose final URL is outside the game's sources, or unknown", async () => {
    const lines: string[] = [];
    configureLogger({ write: (line) => lines.push(line) });
    const redirected = firecrawl(() => scraped("https://www.wowhead.com/tbc/npc=448/hogger", "# Hogger"));
    const result = await call({ game: "wow", url: HOGGER }, redirected.fetchPage);
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: expect.stringMatching(/^That URL leads to a page outside World of Warcraft's vetted sources/) }] });
    expect(lines.map((line) => JSON.parse(line) as unknown)).toContainEqual(expect.objectContaining({ level: "warn", msg: "page refused" }));
    expect(lines.join("\n")).not.toMatch(/wowhead|npc=448/);

    const unknown = firecrawl(() => scraped(undefined, "# Hogger"));
    expect(await call({ game: "wow", url: HOGGER }, unknown.fetchPage)).toEqual({ isError: true, content: [{ type: "text", text: UNAVAILABLE_MESSAGE }] });
  });

  it("refuses a game that is not enabled, and answers no_sources and search_unavailable", async () => {
    const { fetchPage, calls } = firecrawl(() => new Response('{"success":false,"error":"Rate limit exceeded"}', { status: 429 }));
    const url = { game: "wow", url: HOGGER };

    expect(await call(url, fetchPage, [])).toEqual({ isError: true, content: [{ type: "text", text: NOT_ENABLED_MESSAGE }] });
    const noSources: Kit = { ...WOW, manifest: { ...WOW.manifest, flavors: { forever: { status: "experimental", search: [] } } } };
    const none = await call(url, fetchPage, [noSources]);
    expect(none).toEqual({ isError: true, content: [{ type: "text", text: expect.stringMatching(/^World of Warcraft has no vetted search sources yet\./) }] });
    expect(calls).toEqual([]);

    expect(await call(url, null)).toEqual({ isError: true, content: [{ type: "text", text: NOT_SET_UP_MESSAGE }] });
    expect(await call(url, fetchPage)).toEqual({ isError: true, content: [{ type: "text", text: UNAVAILABLE_MESSAGE }] });
    expect(calls).toHaveLength(1);
  });
});
