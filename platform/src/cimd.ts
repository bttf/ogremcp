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
 * - Every fetch oidc-provider makes goes through one counted `fetch`: the
 *   documents, and the `jwks_uri` of a client that signs its token requests
 *   (`private_key_jwt`, as ChatGPT does). Fetches are limited per minute for
 *   each host, and together for the hosts not in `trustedHosts`, so a flood
 *   of made-up hosts cannot use up the trusted hosts' share. No fetch follows
 *   a redirect.
 * - A request that starts a document fetch is limited per minute for each
 *   client address.
 * - A client's JWKS is cached by URL, for its Cache-Control time within 60 s
 *   to 1 h, and read up to 64 KB. oidc-provider builds a new client from a
 *   cached document at each request, so its own JWKS cache does not last
 *   from one token request to the next.
 * - Every redirect URI must be https, or http on a loopback host (§9, and
 *   the MCP 2025-11-25 authorization spec). Matching a loopback redirect URI
 *   whatever its port is RED-308.
 * - A document may not name a `sector_identifier_uri`, and none is fetched:
 *   subjects are never pairwise here.
 *
 * The counts, the JWKS cache, and oidc-provider's document cache are per
 * process. PKCE is required of every client (`oidc.ts`), so of these too.
 * Scopes are `oidc-tokens.ts`.
 */

export interface CimdFetchLimits {
  /** `CIMD_FETCHES_PER_MINUTE`: fetches per minute from the hosts not in `trustedHosts`, together. */
  perMinute: number;
  /** `CIMD_FETCHES_PER_HOST_PER_MINUTE`: fetches per minute from one host. */
  perHostPerMinute: number;
  /** `CIMD_FETCHES_PER_IP_PER_MINUTE`: requests per minute from one client address that start a document fetch. */
  perIpPerMinute: number;
  /** `CIMD_TRUSTED_HOSTS`: hosts whose fetches `perMinute` does not count. `perHostPerMinute` still does. */
  trustedHosts: readonly string[];
}

/**
 * Starting values, not settled numbers (§0). A new client costs one fetch,
 * and then none while its document is cached. The trusted hosts are those of
 * the `client_id` URLs of Claude and Claude Code (`claude.ai`) and ChatGPT
 * (`chatgpt.com`), per spike S2 (RED-298).
 */
export const DEFAULT_CIMD_FETCH_LIMITS: CimdFetchLimits = {
  perMinute: 120,
  perHostPerMinute: 30,
  perIpPerMinute: 10,
  trustedHosts: ["claude.ai", "chatgpt.com"],
};

type Fetch = NonNullable<Configuration["fetch"]>;
type CimdFeature = NonNullable<NonNullable<Configuration["features"]>["clientIdMetadataDocument"]>;

const MINUTE_MS = 60_000;
/** The most of a JWKS response that is read. oidc-provider's own limit for it is unlimited. */
export const JWKS_BODY_LIMIT = 64 * 1024;
const JWKS_CACHE_SECONDS = { min: 60, max: 3600 };
/** How many JWKS URLs are cached at once. oidc-provider caches 100 documents. */
const JWKS_CACHE_SIZE = 100;

/** oidc-provider's loopback hosts: `localhost`, `127.0.0.1`, and `[::1]`, as `URL.hostname` has them. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether a redirect URI is https, or http on a loopback host. */
export function httpsOrLoopback(uri: string): boolean {
  const url = URL.parse(uri);
  if (url === null) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
}

/** Counts per key in fixed one-minute windows. */
class MinuteCounts {
  #start = Number.NEGATIVE_INFINITY;
  readonly #counts = new Map<string, number>();

  constructor(private readonly now: () => number) {}

  get(key: string): number {
    const now = this.now();
    if (now - this.#start >= MINUTE_MS) {
      this.#start = now;
      this.#counts.clear();
    }
    return this.#counts.get(key) ?? 0;
  }

  add(key: string): void {
    this.#counts.set(key, this.get(key) + 1);
  }
}

/**
 * The fetch limits. A refused fetch or request is not counted, so the maps
 * hold at most one entry per fetch that went out this minute. The first
 * refusal in a minute is logged, and the rest of that minute's are not.
 */
export class FetchLimiter {
  readonly #hosts: MinuteCounts;
  readonly #shared: MinuteCounts;
  readonly #ips: MinuteCounts;
  readonly #refusals: MinuteCounts;
  readonly #trusted: ReadonlySet<string>;

  constructor(
    private readonly limits: CimdFetchLimits,
    private readonly log: (line: string) => void,
    now: () => number = Date.now,
  ) {
    this.#hosts = new MinuteCounts(now);
    this.#shared = new MinuteCounts(now);
    this.#ips = new MinuteCounts(now);
    this.#refusals = new MinuteCounts(now);
    this.#trusted = new Set(limits.trustedHosts);
  }

  /** Before a document fetch from `host`: whether the request from `ip` may start it. Counts the request. */
  allowDocumentFetch(host: string, ip: string | undefined): boolean {
    const over = this.#over(host);
    if (over !== null) return this.#refuse(over);
    if (ip !== undefined) {
      if (this.#ips.get(ip) >= this.limits.perIpPerMinute) return this.#refuse("one client address");
      this.#ips.add(ip);
    }
    return true;
  }

  /** Before every fetch from `host`: whether it may go. Counts it. */
  take(host: string): boolean {
    const over = this.#over(host);
    if (over !== null) return this.#refuse(over);
    this.#hosts.add(host);
    if (!this.#trusted.has(host)) this.#shared.add("");
    return true;
  }

  /** The limit a fetch from `host` would go over, or null. */
  #over(host: string): string | null {
    if (this.#hosts.get(host) >= this.limits.perHostPerMinute) return `host ${host}`;
    if (!this.#trusted.has(host) && this.#shared.get("") >= this.limits.perMinute) return "the untrusted hosts together";
    return null;
  }

  #refuse(limit: string): false {
    if (this.#refusals.get("") === 0) {
      this.log(`oauth: outgoing fetches over the limit for ${limit}; the rest of this minute's refusals are not logged`);
    }
    this.#refusals.add("");
    return false;
  }
}

/**
 * The JWKS of clients' `jwks_uri`s, by URL. A URL is cached only once a
 * client that names it is in use (`register`), so a document fetch is never
 * cached here. Concurrent fetches of one URL share one.
 */
class JwksCache {
  readonly #entries = new Map<string, { body: string; until: number } | null>();
  readonly #pending = new Map<string, Promise<string>>();

  constructor(private readonly now: () => number) {}

  register(uri: string): void {
    const href = URL.parse(uri)?.href;
    if (href === undefined || this.#entries.has(href)) return;
    if (this.#entries.size >= JWKS_CACHE_SIZE) this.#entries.delete(this.#entries.keys().next().value ?? "");
    this.#entries.set(href, null);
  }

  registered(href: string): boolean {
    return this.#entries.has(href);
  }

  /** The cached JWKS of `href`, or else the one `fetchBody` fetches. */
  async get(href: string, fetchBody: () => Promise<{ body: string; maxAge: number }>): Promise<string> {
    const entry = this.#entries.get(href);
    if (entry != null && entry.until > this.now()) return entry.body;
    let pending = this.#pending.get(href);
    if (pending === undefined) {
      pending = fetchBody().then(({ body, maxAge }) => {
        const seconds = Math.min(JWKS_CACHE_SECONDS.max, Math.max(JWKS_CACHE_SECONDS.min, maxAge));
        if (this.#entries.has(href)) this.#entries.set(href, { body, until: this.now() + seconds * 1000 });
        return body;
      });
      const settle = () => this.#pending.delete(href);
      pending.then(settle, settle);
      this.#pending.set(href, pending);
    }
    return pending;
  }
}

/** The body of `response`, refused past `limit` bytes. */
async function readLimited(response: Response, limit: number): Promise<string> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("response too large");
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader?.read();
    if (chunk === undefined || chunk.done) break;
    size += chunk.value.length;
    if (size > limit) {
      await reader?.cancel();
      throw new Error("response too large");
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function maxAgeSeconds(response: Response): number {
  const match = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(response.headers.get("cache-control") ?? "");
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

/** The settings `createOidcProvider` spreads in, and the feature it adds. */
export interface CimdConfiguration {
  settings: Pick<Configuration, "fetch" | "fetchResponseBodyLimits" | "sectorIdentifierUriValidate">;
  features: { clientIdMetadataDocument: CimdFeature };
}

/**
 * `fetch` does each fetch oidc-provider asks for, after its checks. It is
 * given oidc-provider's options, with the SSRF-guarded `dispatcher`; by
 * default it is the global `fetch`, as oidc-provider's own default is.
 */
export function cimdConfiguration(
  limits: CimdFetchLimits,
  log: (line: string) => void,
  fetch: Fetch = (input, init) => globalThis.fetch(input, init),
): CimdConfiguration {
  const limiter = new FetchLimiter(limits, log);
  const jwks = new JwksCache(Date.now);

  const counted = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (!limiter.take(url.hostname)) return Promise.reject(new Error("outgoing fetch over the limit"));
    return fetch(input, { ...init, redirect: "manual" });
  };

  return {
    settings: {
      fetch: async (input, init) => {
        const href = new URL(input instanceof Request ? input.url : input).href;
        if (!jwks.registered(href)) return counted(input, init);
        const body = await jwks.get(href, async () => {
          const response = await counted(input, init);
          if (response.status !== 200) {
            await response.body?.cancel();
            throw new Error(`jwks_uri answered ${response.status}`);
          }
          return { body: await readLimited(response, JWKS_BODY_LIMIT), maxAge: maxAgeSeconds(response) };
        });
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      },
      fetchResponseBodyLimits: { jwks_uri: JWKS_BODY_LIMIT, sector_identifier_uri: JWKS_BODY_LIMIT },
      // Subjects are never pairwise, so a sector_identifier_uri is never fetched. A document that names one is refused below.
      sectorIdentifierUriValidate: () => false,
    },
    features: {
      clientIdMetadataDocument: {
        enabled: true,
        // A later draft that breaks this one throws at start instead of changing behavior.
        ack: "draft-02",
        // Only a document that is not cached is fetched. `ctx` is missing outside an oidc-provider request.
        allowFetch: (ctx: { ip?: string } | undefined, clientId) => limiter.allowDocumentFetch(new URL(clientId).hostname, ctx?.ip),
        // At each use of a client from a document, cached or not.
        allowClient: (_ctx, client) => {
          if (client.sectorIdentifierUri !== undefined) return false;
          if (!(client.redirectUris ?? []).every(httpsOrLoopback)) return false;
          if (client.jwksUri !== undefined) jwks.register(client.jwksUri);
          return true;
        },
      },
    },
  };
}
