import type { Configuration } from "oidc-provider";

/**
 * Client ID metadata documents (CIMD, §9, §19.1 D7). A client whose
 * `client_id` is an https URL, such as Claude's
 * `https://claude.ai/oauth/mcp-oauth-client-metadata`, is registered by the
 * JSON document at that URL. oidc-provider fetches, checks, and caches the
 * document (`features.clientIdMetadataDocument`, draft-02). Its own checks
 * stand, unchanged: the fetch refuses private, loopback, and link-local
 * addresses (SSRF), reads at most 5 KB, times out after 2.5 s, and follows no
 * redirect; only a valid document is cached, for its Cache-Control or Expires
 * time within 30 s to 24 h; the document's `client_id` must equal the URL
 * exactly, and it may not use a client secret.
 *
 * On top of those:
 * - Fetches are limited per minute, for each host of a `client_id` and in
 *   all (`CimdFetchLimits`). A cached document needs no fetch. The counts
 *   and oidc-provider's cache are per process.
 * - Every redirect URI must be https, or http on a loopback host (§9, and
 *   the MCP 2025-11-25 authorization spec). Matching a loopback redirect URI
 *   whatever its port is RED-308.
 *
 * PKCE is required of every client (`oidc.ts`), so of these too. Scopes are
 * RED-302's.
 */

export interface CimdFetchLimits {
  /** `CIMD_FETCHES_PER_MINUTE`: metadata document fetches per minute, for all hosts together. */
  perMinute: number;
  /** `CIMD_FETCHES_PER_HOST_PER_MINUTE`: metadata document fetches per minute for the `client_id` URLs of one host. */
  perHostPerMinute: number;
}

/**
 * Starting values, not settled numbers (§0). A new client costs one fetch,
 * and then none while its document is cached. The per-host limit keeps this
 * service from being used to flood one host; the total bounds the service's
 * own outgoing requests.
 */
export const DEFAULT_CIMD_FETCH_LIMITS: CimdFetchLimits = { perMinute: 120, perHostPerMinute: 30 };

const WINDOW_MS = 60_000;

/** oidc-provider's loopback hosts: `localhost`, `127.0.0.1`, and `[::1]`, as `URL.hostname` has them. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether a redirect URI is https, or http on a loopback host. */
export function httpsOrLoopback(uri: string): boolean {
  const url = URL.parse(uri);
  if (url === null) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
}

/**
 * Counts fetches in fixed one-minute windows. A refused fetch is not
 * counted. The first refusal in a window is logged, and the rest of that
 * window's are not.
 */
export class FetchLimiter {
  #windowStart = Number.NEGATIVE_INFINITY;
  #total = 0;
  readonly #perHost = new Map<string, number>();
  #logged = false;

  constructor(
    private readonly limits: CimdFetchLimits,
    private readonly log: (line: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether a fetch from `host` may go now. Counts it when it may. */
  allow(host: string): boolean {
    const now = this.now();
    if (now - this.#windowStart >= WINDOW_MS) {
      this.#windowStart = now;
      this.#total = 0;
      this.#perHost.clear();
      this.#logged = false;
    }
    const count = this.#perHost.get(host) ?? 0;
    const over = this.#total >= this.limits.perMinute ? "all hosts" : count >= this.limits.perHostPerMinute ? host : null;
    if (over !== null) {
      if (!this.#logged) {
        this.#logged = true;
        this.log(`oauth: client ID metadata document fetches over the limit for ${over}; the rest of this minute's refusals are not logged`);
      }
      return false;
    }
    this.#perHost.set(host, count + 1);
    this.#total += 1;
    return true;
  }
}

type CimdFeature = NonNullable<NonNullable<Configuration["features"]>["clientIdMetadataDocument"]>;

/**
 * The feature's configuration. oidc-provider calls `allowFetch` before each
 * fetch, with a `client_id` it has already checked is a valid https URL, and
 * `allowClient` each time a client from a document is used, cached or not.
 * Either one's `false` answers `invalid_client`.
 */
export function clientIdMetadataDocument(limits: CimdFetchLimits, log: (line: string) => void): CimdFeature {
  const limiter = new FetchLimiter(limits, log);
  return {
    enabled: true,
    // A later draft that breaks this one throws at start instead of changing behavior.
    ack: "draft-02",
    allowFetch: (_ctx, clientId) => limiter.allow(new URL(clientId).hostname),
    allowClient: (_ctx, client) => (client.redirectUris ?? []).every(httpsOrLoopback),
  };
}
