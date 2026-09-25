/**
 * Firecrawl's search and scrape endpoints (v2), the search provider of §12.
 * One POST per search or page. A search scrapes no page: a scrape costs a
 * credit per hit, and the hit's own query-relevant snippet (`description`)
 * is the excerpt. A search of 1 to 10 hits costs 2 credits, a scrape 1
 * (docs/spikes/s3-firecrawl-scoping.md).
 *
 * A page is fetched by Firecrawl, never by the platform, so the platform
 * makes no request to a URL an agent names.
 *
 * The API key goes in the `Authorization` header and nowhere else. No error
 * repeats the key, the query, the URL, or Firecrawl's answer.
 *
 * Adapted from `cloud/src/firecrawl.ts` in bttf/wow-guide@df80260. The
 * request is the S3 shape: the scope goes into the query as `site:` terms
 * (`search.ts`), not into `includeDomains`, which S3 found slow and blind to
 * paths. The answer is checked by hand instead of with zod.
 */

export const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";
export const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";

/**
 * The most time one Firecrawl request takes, its answer included, when
 * `FIRECRAWL_TIMEOUT_MS` is unset (*proposed*). S3 measured a median of 0.8
 * seconds and a maximum of 3.1 for a search.
 */
export const DEFAULT_FIRECRAWL_TIMEOUT_MS = 10_000;

export interface FirecrawlOptions {
  /** `FIRECRAWL_API_KEY`. Never logged or repeated. */
  apiKey: string;
  /** `FIRECRAWL_TIMEOUT_MS`. Firecrawl is told to stop a second earlier. */
  timeoutMs: number;
  /** Default: the global `fetch`. Tests pass a stub: no test calls Firecrawl. */
  fetch?: typeof fetch;
}

/** A search hit as Firecrawl gives it. Untrusted. */
export interface FirecrawlHit {
  url: string;
  title?: string;
  /** Firecrawl's query-relevant snippet. */
  description?: string;
}

/** A page as Firecrawl scrapes it. Untrusted. */
export interface FirecrawlPage {
  /**
   * The page's final URL, after redirects (`metadata.url`). Firecrawl gives
   * the URL asked for as `metadata.sourceURL`, and no redirect chain.
   */
  url: string;
  /** The page's main content as markdown. */
  markdown: string;
  /** The HTTP status of the page (`metadata.statusCode`), when Firecrawl gives one. */
  status?: number;
}

/**
 * Why a Firecrawl request failed: `timeout`, `network`, `http` with the
 * status (429 when rate-limited), or `response` for an answer that is not a
 * successful search or scrape. It never carries Firecrawl's message, which
 * can repeat the request.
 */
export class FirecrawlError extends Error {
  override name = "FirecrawlError";

  constructor(
    readonly reason: "timeout" | "network" | "http" | "response",
    readonly status?: number,
  ) {
    super(`Firecrawl request failed: reason=${reason}${status === undefined ? "" : ` status=${status}`}`);
  }
}

/**
 * The level of a failure's log line: `error` for a 4xx other than 429, which
 * is ours to fix (a bad key, no credits left, or a bad request), and `warn`
 * for the rest.
 */
export function failureLevel(err: FirecrawlError): "warn" | "error" {
  return err.reason === "http" && err.status !== undefined && err.status !== 429 && err.status < 500 ? "error" : "warn";
}

/** The web hits of a search for `query`, at most `limit`. Throws a `FirecrawlError` on any failure. */
export async function firecrawlSearch(options: FirecrawlOptions, query: string, limit: number): Promise<FirecrawlHit[]> {
  const hits = webHits(await post(options, FIRECRAWL_SEARCH_URL, { query, limit, sources: ["web"] }));
  if (hits === null) throw new FirecrawlError("response");
  return hits;
}

/**
 * The page at `url`, as markdown of its main content (S3). `parsers: []`
 * turns off PDF parsing, which costs a credit per PDF page. Throws a
 * `FirecrawlError` on any failure, and on an answer without the page's final
 * URL: without it, a redirect out of scope could not be seen.
 */
export async function firecrawlScrape(options: FirecrawlOptions, url: string): Promise<FirecrawlPage> {
  const page = scrapedPage(await post(options, FIRECRAWL_SCRAPE_URL, { url, formats: ["markdown"], onlyMainContent: true, parsers: [] }));
  if (page === null) throw new FirecrawlError("response");
  return page;
}

/** POSTs `body` to `endpoint`, and answers the JSON. Firecrawl is told to stop a second before `timeoutMs`. */
async function post(options: FirecrawlOptions, endpoint: string, body: object): Promise<unknown> {
  let res: Response;
  try {
    res = await (options.fetch ?? fetch)(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ ...body, timeout: Math.max(1000, options.timeoutMs - 1000) }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (err) {
    throw new FirecrawlError(isTimeout(err) ? "timeout" : "network");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new FirecrawlError(res.status === 408 ? "timeout" : "http", res.status);
  }
  try {
    return await res.json();
  } catch (err) {
    throw new FirecrawlError(isTimeout(err) ? "timeout" : "response");
  }
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/** `data.web` of a successful search answer, or null. A hit without a string `url` is skipped; a title or snippet that is not a string is left out. */
function webHits(json: unknown): FirecrawlHit[] | null {
  if (!isObject(json) || json["success"] !== true) return null;
  const data = json["data"];
  if (data === undefined) return [];
  if (!isObject(data)) return null;
  const web = data["web"];
  if (web === undefined) return [];
  if (!Array.isArray(web)) return null;
  const hits: FirecrawlHit[] = [];
  for (const item of web as unknown[]) {
    if (!isObject(item) || typeof item["url"] !== "string") continue;
    const { url, title, description } = item;
    hits.push({
      url,
      ...(typeof title === "string" && { title }),
      ...(typeof description === "string" && { description }),
    });
  }
  return hits;
}

/** The page of a successful scrape answer, or null. A missing `markdown` is an empty page; a missing final URL is no page. */
function scrapedPage(json: unknown): FirecrawlPage | null {
  if (!isObject(json) || json["success"] !== true || !isObject(json["data"])) return null;
  const { markdown, metadata } = json["data"];
  if (!isObject(metadata) || typeof metadata["url"] !== "string") return null;
  if (markdown !== undefined && typeof markdown !== "string") return null;
  const status = metadata["statusCode"];
  return { url: metadata["url"], markdown: markdown ?? "", ...(typeof status === "number" && { status }) };
}

function isObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
