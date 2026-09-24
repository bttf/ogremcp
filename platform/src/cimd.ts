import { AsyncLocalStorage } from "node:async_hooks";
import { isIPv6 } from "node:net";

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
 *   (`private_key_jwt`, as ChatGPT does). No fetch follows a redirect. Each
 *   is limited per minute: for its host, for the client address of the
 *   request that caused it (an IPv6 address by its /64), and for all fetches
 *   together. The documents of the exact `client_id`s in `trustedClientIds`,
 *   and their JWKS, are not limited, so no flood of other clients, on their
 *   hosts or any other, can block them. The cache, the size caps, and the
 *   no-redirect rule still apply to them.
 * - A `jwks_uri` must be on the host of its `client_id`.
 * - A client's JWKS is cached by URL, for its Cache-Control time within 60 s
 *   to 1 h, and read up to 64 KB. oidc-provider builds a new client from a
 *   cached document at each request, so its own JWKS cache does not last
 *   from one token request to the next.
 * - Every redirect URI must be https, or http on a loopback host (§9, and
 *   the MCP 2025-11-25 authorization spec). A loopback redirect URI matches
 *   whatever its port (`oidc-registration.ts`).
 * - A document may not name a `sector_identifier_uri`, and none is fetched:
 *   subjects are never pairwise here.
 *
 * The counts, the JWKS cache, and oidc-provider's document cache are per
 * process. PKCE is required of every client (`oidc.ts`), so of these too.
 * Scopes are `oidc-tokens.ts`.
 */

export interface CimdFetchLimits {
  /** `CIMD_FETCHES_PER_MINUTE`: limited fetches per minute, together. */
  perMinute: number;
  /** `CIMD_FETCHES_PER_HOST_PER_MINUTE`: limited fetches per minute from one host. */
  perHostPerMinute: number;
  /** `CIMD_FETCHES_PER_IP_PER_MINUTE`: limited fetches per minute caused by requests from one client address. */
  perIpPerMinute: number;
  /** `CIMD_TRUSTED_CLIENT_IDS`: exact `client_id` URLs whose documents and JWKS are fetched without a limit. */
  trustedClientIds: readonly string[];
}

/**
 * Starting values, not settled numbers (§0). A new client costs one fetch,
 * and then none while its document is cached. The trusted `client_id`s are
 * those of Claude, Claude Code, and ChatGPT, per spike S2 (RED-298).
 */
export const DEFAULT_CIMD_FETCH_LIMITS: CimdFetchLimits = {
  perMinute: 120,
  perHostPerMinute: 30,
  perIpPerMinute: 10,
  trustedClientIds: [
    "https://claude.ai/oauth/mcp-oauth-client-metadata",
    "https://claude.ai/oauth/claude-code-client-metadata",
    "https://chatgpt.com/oauth/client.json",
  ],
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

/** Whether a URI is http or https on a loopback host, so that it points at the user's own computer. */
export function onLoopbackHost(uri: string): boolean {
  const url = URL.parse(uri);
  if (url === null) return false;
  return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTS.has(url.hostname);
}

/** Whether a redirect URI is http on a loopback host: a native app's loopback redirect (RFC 8252 §7.3). */
export function loopbackRedirect(uri: string): boolean {
  return URL.parse(uri)?.protocol === "http:" && onLoopbackHost(uri);
}

/** Whether a redirect URI is https, or http on a loopback host. */
export function httpsOrLoopback(uri: string): boolean {
  return URL.parse(uri)?.protocol === "https:" || loopbackRedirect(uri);
}

/**
 * Whether a client's redirect URIs make it a native app with a loopback
 * redirect (`oidc-registration.ts`): at least one is http on a loopback
 * host, and each of the others is either that or https on a host that is not
 * a loopback host. A client with any other redirect URI keeps its
 * `application_type`: oidc-provider refuses http off a loopback host and
 * https on one from a native client, and accepts other schemes from a native
 * client only.
 */
export function nativeLoopbackRedirects(uris: readonly unknown[]): boolean {
  let loopback = false;
  for (const uri of uris) {
    if (typeof uri !== "string" || !httpsOrLoopback(uri)) return false;
    if (loopbackRedirect(uri)) loopback = true;
    else if (onLoopbackHost(uri)) return false;
  }
  return loopback;
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
 * The key of a client address for the per-address limit: an IPv4 address
 * whole, an IPv6 address by its /64, since one host commonly holds a whole
 * /64.
 */
export function addressKey(address: string): string {
  const ip = address.replace(/%.*$/, "").toLowerCase();
  if (!isIPv6(ip)) return ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped?.[1] !== undefined) return mapped[1];
  const [head = "", tail] = ip.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  // A dotted IPv4 tail holds two groups.
  const size = (groups: string[]) => groups.reduce((n, group) => n + (group.includes(".") ? 2 : 1), 0);
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - size(left) - size(right)).fill("0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((group) => group.padStart(4, "0"))
    .join(":")}::/64`;
}

/** What a fetch is for: a client's document, or its JWKS. */
export type FetchKind = "document" | "jwks";

/**
 * The fetch limits. A refused fetch is not counted, so the maps hold at most
 * one entry per fetch that went out this minute. The first refusal in a
 * minute is logged, and the rest of that minute's are not.
 */
export class FetchLimiter {
  readonly #hosts: MinuteCounts;
  readonly #all: MinuteCounts;
  readonly #addresses: MinuteCounts;
  readonly #refusals: MinuteCounts;
  readonly #trustedClientIds: ReadonlySet<string>;
  readonly #trustedJwks = new Set<string>();

  constructor(
    private readonly limits: CimdFetchLimits,
    private readonly log: (line: string) => void,
    now: () => number = Date.now,
  ) {
    this.#hosts = new MinuteCounts(now);
    this.#all = new MinuteCounts(now);
    this.#addresses = new MinuteCounts(now);
    this.#refusals = new MinuteCounts(now);
    this.#trustedClientIds = new Set(limits.trustedClientIds);
  }

  /** Whether `clientId` is exactly a trusted one. */
  trusts(clientId: string): boolean {
    return this.#trustedClientIds.has(clientId);
  }

  /** Trusts the JWKS at `href`, the `jwks_uri` of a trusted client. */
  trustJwks(href: string): void {
    this.#trustedJwks.add(href);
  }

  /** Whether a fetch of `url` (exactly as oidc-provider asks for it), caused by a request from `address`, fits. Counts nothing. */
  fits(url: string, kind: FetchKind, address: string | undefined): boolean {
    return this.#check(url, kind, address, false);
  }

  /** Whether that fetch may go. Counts it. */
  take(url: string, kind: FetchKind, address: string | undefined): boolean {
    return this.#check(url, kind, address, true);
  }

  #check(url: string, kind: FetchKind, address: string | undefined, count: boolean): boolean {
    if (kind === "document" ? this.#trustedClientIds.has(url) : this.#trustedJwks.has(url)) return true;
    const host = new URL(url).hostname;
    let over: string | null = null;
    if (this.#hosts.get(host) >= this.limits.perHostPerMinute) over = `host ${host}`;
    else if (this.#all.get("") >= this.limits.perMinute) over = "all hosts";
    else if (address !== undefined && this.#addresses.get(address) >= this.limits.perIpPerMinute) over = "one client address";
    if (over !== null) {
      if (this.#refusals.get("") === 0) {
        this.log(`oauth: outgoing fetches over the limit for ${over}; the rest of this minute's refusals are not logged`);
      }
      this.#refusals.add("");
      return false;
    }
    if (count) {
      this.#hosts.add(host);
      this.#all.add("");
      if (address !== undefined) this.#addresses.add(address);
    }
    return true;
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

/**
 * The settings `createOidcProvider` spreads in, the feature it adds, and the
 * middleware it gives `provider.use`. The middleware keeps each request's
 * client address for the fetches the request causes.
 */
export interface CimdConfiguration {
  settings: Pick<Configuration, "fetch" | "fetchResponseBodyLimits" | "sectorIdentifierUriValidate">;
  features: { clientIdMetadataDocument: CimdFeature };
  middleware: (ctx: { ip: string }, next: () => Promise<void>) => Promise<void>;
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
  // Outside an oidc-provider request, such as the consent page's details, there is no address.
  const requestAddress = new AsyncLocalStorage<string>();

  const counted = (url: string, kind: FetchKind, init?: RequestInit): Promise<Response> => {
    if (!limiter.take(url, kind, requestAddress.getStore())) return Promise.reject(new Error("outgoing fetch over the limit"));
    return fetch(url, { ...init, redirect: "manual" });
  };

  return {
    middleware: (ctx, next) => requestAddress.run(addressKey(ctx.ip), next),
    settings: {
      fetch: async (input, init) => {
        // A document's URL is compared exactly as the client sent it, so it is not normalized.
        const url = input instanceof Request ? input.url : String(input);
        const href = new URL(url).href;
        if (!jwks.registered(href)) return counted(url, "document", init);
        const body = await jwks.get(href, async () => {
          const response = await counted(href, "jwks", init);
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
        // Only a document that is not cached is fetched. This answers "fetch not allowed" early; `fetch` counts.
        allowFetch: (ctx: { ip?: string } | undefined, clientId) =>
          limiter.fits(clientId, "document", ctx?.ip === undefined ? undefined : addressKey(ctx.ip)),
        // At each use of a client from a document, cached or not.
        allowClient: (_ctx, client) => {
          if (client.sectorIdentifierUri !== undefined) return false;
          if (!(client.redirectUris ?? []).every(httpsOrLoopback)) return false;
          if (client.jwksUri !== undefined) {
            const jwksUri = URL.parse(client.jwksUri);
            if (jwksUri === null || jwksUri.host !== new URL(client.clientId).host) return false;
            jwks.register(jwksUri.href);
            if (limiter.trusts(client.clientId)) limiter.trustJwks(jwksUri.href);
          }
          return true;
        },
      },
    },
  };
}
