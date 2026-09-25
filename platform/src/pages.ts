import { failureLevel, FirecrawlError, type FirecrawlOptions, type FirecrawlPage, firecrawlScrape } from "./firecrawl.js";
import { logger } from "./log.js";

/**
 * Page fetches (§12), behind the `fetch_game_page` tool
 * (`fetch-game-page.ts`).
 *
 * `PageFetch` is the one call to the provider. Its input is the page cache's
 * key (§12): the page's URL, in scope and without its fragment (`pageKey`).
 * Its answer is the page's final URL, unchecked, and the page's text as
 * `pageText` makes it. So the shared cache can wrap it and store the answer
 * (RED-335), and the caller checks the final URL against the game's scope on
 * every call, from the cache too.
 *
 * `pageText` removes images and link targets and keeps link text (S3,
 * docs/spikes/s3-firecrawl-scoping.md). Wowhead markdown is mostly that
 * markup: on the S3 pages, every answer then started before character 7,700.
 */

/**
 * The most characters of Firecrawl's markdown `pageText` reads. The markdown
 * is cut to it before any pattern runs, so a pathological page stays fast.
 * S3's longest page had 75.4k characters.
 */
export const MAX_PAGE_SOURCE = 100_000;

/** A fetched page. Its text comes from the web: untrusted (§10.5). */
export interface Page {
  /** The final URL Firecrawl reports, after redirects. Unchecked: the caller checks it against the scope. */
  url: string;
  /** `pageText` of Firecrawl's markdown. */
  markdown: string;
  /** Whether Firecrawl's markdown was longer than `MAX_PAGE_SOURCE`, so the end of the page is missing. */
  cut: boolean;
  /** The page's HTTP status, when Firecrawl reports one. The caller refuses a 4xx or 5xx page. */
  status?: number;
}

/**
 * Fetches the page at `url`, a `pageKey` result. Throws a `FirecrawlError`
 * when the provider fails.
 */
export type PageFetch = (url: string) => Promise<Page>;

/** A page's cache key (S3): the URL, an `inScope` result, without its fragment. Wowhead links carry fragments such as `#comments`. */
export function pageKey(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.href;
}

/**
 * Link text: up to 1,000 characters with no bracket or backslash, or escapes
 * such as `\[`. It can span lines: a link around a block, such as a card,
 * does. The bounds keep each pattern's work per starting point small: longer
 * markup is left as it is.
 */
const LINK_TEXT = String.raw`(?:[^[\]\\]|\\[\s\S]){0,1000}`;
/**
 * A link target: at most 1,906 characters with no whitespace, holding up to
 * three parenthesized parts such as `Hogger_(Classic)`, then an optional
 * title.
 */
const LINK_TARGET = String.raw`[^()\s]{0,1000}(?:\([^()\s]{0,100}\)[^()\s]{0,200}){0,3}(?:\s{1,20}"[^"\n]{0,300}")?`;
const IMAGE = new RegExp(String.raw`!\[${LINK_TEXT}\]\(${LINK_TARGET}\)`, "g");
const LINK = new RegExp(String.raw`\[(${LINK_TEXT})\]\(${LINK_TARGET}\)`, "g");

/**
 * `markdown`, cut to `MAX_PAGE_SOURCE` characters, without images and link
 * targets: an image goes, and a link becomes its text. Images go first, so a
 * link around an image goes too. Trailing spaces go, and blank lines collapse
 * to one.
 */
export function pageText(markdown: string): string {
  return markdown
    .slice(0, MAX_PAGE_SOURCE)
    .replace(IMAGE, "")
    .replace(LINK, "$1")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The `PageFetch` on Firecrawl: one scrape per call. Each call writes one log
 * line with the page's HTTP status, sizes, and time, or the failure's reason
 * and status. Never the URL: the line carries the user's uuid.
 */
export function firecrawlPageFetch(options: FirecrawlOptions): PageFetch {
  return async (url) => {
    const started = performance.now();
    let page: FirecrawlPage;
    try {
      page = await firecrawlScrape(options, url);
    } catch (err) {
      if (err instanceof FirecrawlError) {
        logger[failureLevel(err)]("page fetch failed", { reason: err.reason, status: err.status, duration_ms: since(started) });
      }
      throw err;
    }
    const markdown = pageText(page.markdown);
    logger.info("page fetch", { status: page.status, source_chars: page.markdown.length, chars: markdown.length, duration_ms: since(started) });
    return { url: page.url, markdown, cut: page.markdown.length > MAX_PAGE_SOURCE, ...(page.status !== undefined && { status: page.status }) };
  };
}

function since(started: number): number {
  return Math.round(performance.now() - started);
}
