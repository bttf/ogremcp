/**
 * Firecrawl's search endpoint (v2), the search provider of §12. One POST per
 * search. No page is scraped: a scrape costs a credit per hit, and the hit's
 * own query-relevant snippet (`description`) is the excerpt. A search of 1 to
 * 10 hits costs 2 credits (docs/spikes/s3-firecrawl-scoping.md).
 *
 * The API key goes in the `Authorization` header and nowhere else. No error
 * repeats the key, the query, or Firecrawl's answer.
 *
 * Adapted from `cloud/src/firecrawl.ts` in bttf/wow-guide@df80260. The
 * request is the S3 shape: the scope goes into the query as `site:` terms
 * (`search.ts`), not into `includeDomains`, which S3 found slow and blind to
 * paths. The answer is checked by hand instead of with zod.
 */

export const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";

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

/**
 * Why a Firecrawl request failed: `timeout`, `network`, `http` with the
 * status (429 when rate-limited), or `response` for an answer that is not a
 * successful search. It never carries Firecrawl's message, which can repeat
 * the request.
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

/** The web hits of a search for `query`, at most `limit`. Throws a `FirecrawlError` on any failure. */
export async function firecrawlSearch(options: FirecrawlOptions, query: string, limit: number): Promise<FirecrawlHit[]> {
  const body = { query, limit, sources: ["web"], timeout: Math.max(1000, options.timeoutMs - 1000) };
  let res: Response;
  try {
    res = await (options.fetch ?? fetch)(FIRECRAWL_SEARCH_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (err) {
    throw new FirecrawlError(isTimeout(err) ? "timeout" : "network");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new FirecrawlError(res.status === 408 ? "timeout" : "http", res.status);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    throw new FirecrawlError(isTimeout(err) ? "timeout" : "response");
  }
  const hits = webHits(json);
  if (hits === null) throw new FirecrawlError("response");
  return hits;
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

function isObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
