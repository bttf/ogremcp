import { BlockList, isIP } from "node:net";

import type Provider from "oidc-provider";
import { type ClientMetadata, type Configuration, errors, type KoaContextWithOIDC } from "oidc-provider";
import type { Pool } from "pg";

import { addressKey, httpsOrLoopback, nativeLoopbackRedirects } from "./cimd.js";
import { failureCode } from "./db.js";
import { BRIDGE_CLIENT_ID, DEVICE_CODE_GRANT } from "./devices.js";
import { logger } from "./log.js";
import { type Bucket, level, type Limit, limit, waitSeconds } from "./token-bucket.js";

/**
 * Dynamic client registration (§9, RFC 7591): the fallback for an agent that
 * sends no CIMD client ID. Registration is open, with no initial access token,
 * at `/oauth/register`.
 *
 * A registered client is a public agent client:
 *
 * - `token_endpoint_auth_method` is `none`, with no secret. A request that
 *   leaves it out gets `none` (RFC 7591 §3.2.1 lets the server replace a
 *   value); any other value is refused. PKCE is required of every client
 *   (`oidc.ts`).
 * - `grant_types` may hold only `authorization_code` and `refresh_token`, and
 *   `response_types` only `code`.
 * - Each redirect URI is https, or http on a loopback host: `localhost`,
 *   `127.0.0.1`, or `[::1]`.
 * - `scope` may not name `ingest`, the bridge scope (§8.1). Other values are
 *   accepted and not stored: oidc-provider checks a client's `scope` against
 *   its own scopes only, and `read` is the MCP server's resource scope, not
 *   one of those. What an agent client is granted is set at authorization
 *   (RED-302). Claude has sent scopes the server does not define, such as
 *   `claudeai`, so an unknown value is dropped, not refused.
 * - `jwks`, `jwks_uri`, and `sector_identifier_uri` are refused. A public
 *   client has no keys, and oidc-provider would fetch `sector_identifier_uri`
 *   from this server at registration.
 * - `post_logout_redirect_uris` is dropped, from every client oidc-provider
 *   builds: RP-initiated logout is off (`oidc.ts`), and agents do not use it.
 *
 * No registration access token is issued, and registration management
 * (RFC 7592) is off: a client cannot read, change, or delete its registration.
 *
 * Loopback redirects (§9, RFC 8252 §7.3) apply to every client oidc-provider
 * builds: registered, CIMD, and static. A client whose redirect URIs pass
 * `nativeLoopbackRedirects` (`cimd.ts`) gets `application_type` `native`
 * when it sent none, `web`, or `native`. Claude Code's CIMD document, with
 * `http://localhost/callback`, sets none. For a native client, oidc-provider
 * matches an http redirect URI on a loopback host with the port left out of
 * both sides. The scheme, host, path, and query still match exactly, and
 * every other redirect URI matches exactly. A native client also gets the
 * consent prompt at every authorization request, as RFC 8252 §8.6 asks.
 *
 * The endpoint is rate-limited with token buckets (`RegistrationLimiter`):
 * one per client address, one shared by the addresses in the trusted ranges,
 * and one for every registration. Claude's hosted clients register from
 * Anthropic's egress range, one new client per connection until the server
 * offers CIMD, so its users share the trusted bucket and not one address's.
 * The buckets are in memory: they start full when the process starts, and
 * each replica keeps its own.
 *
 * Each time the token endpoint issues a client a token, its row's
 * `last_used_at` is set (migration 0004), and so is its grant's, which the
 * Connected agents page shows (`agents.ts`, migration 0014).
 * `startClientCleanup` deletes the clients that have not got a token for
 * `unusedClientDays`, with their grants and tokens. The token endpoint then
 * answers `401 invalid_client` for them, which tells Claude to register
 * again.
 */

/** An address range in CIDR notation, such as `160.79.104.0/21`. */
export interface AddressRange {
  address: string;
  prefix: number;
  family: "ipv4" | "ipv6";
}

/**
 * The address ranges of a comma-separated list such as
 * `160.79.104.0/21, 2001:db8::/32`. Throws on an entry that is not one.
 */
export function parseAddressRanges(name: string, value: string): AddressRange[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const [address = "", prefix = "", extra] = entry.split("/");
      const version = isIP(address);
      const bits = Number(prefix);
      if (version === 0 || extra !== undefined || !/^\d{1,3}$/.test(prefix) || bits > (version === 4 ? 32 : 128)) {
        throw new Error(`${name} must list address ranges only, such as 160.79.104.0/21`);
      }
      return { address, prefix: bits, family: version === 4 ? "ipv4" : "ipv6" };
    });
}

/** The registration limits (*proposed*, §0). `config.ts` reads them from the environment. */
export interface RegistrationSettings {
  /** `DCR_RATE_PER_HOUR`: registrations one address may make per hour once its burst is spent. */
  ratePerHour: number;
  /** `DCR_BURST`: registrations one address may make at once. */
  burst: number;
  /**
   * `DCR_TRUSTED_RANGES`: addresses that share one bucket instead of one each.
   * Default: Anthropic's egress range, which Claude's hosted clients register from.
   */
  trustedRanges: AddressRange[];
  /** `DCR_TRUSTED_RATE_PER_HOUR`: the trusted ranges' shared rate. */
  trustedRatePerHour: number;
  /** `DCR_TRUSTED_BURST`: the trusted ranges' shared burst. */
  trustedBurst: number;
  /** `DCR_GLOBAL_RATE_PER_HOUR`: registrations from every address together, per hour. */
  globalRatePerHour: number;
  /** `DCR_GLOBAL_BURST`: registrations from every address together, at once. */
  globalBurst: number;
  /**
   * `OAUTH_CLIENT_UNUSED_DAYS`: a registered client that has not got a token
   * for this many days is deleted. A client that never got one counts from
   * its registration.
   */
  unusedClientDays: number;
}

/** Anthropic's egress range (IPv4). */
export const DEFAULT_TRUSTED_RANGES = "160.79.104.0/21";

export const DEFAULT_REGISTRATION: RegistrationSettings = {
  ratePerHour: 10,
  burst: 5,
  trustedRanges: parseAddressRanges("DCR_TRUSTED_RANGES", DEFAULT_TRUSTED_RANGES),
  trustedRatePerHour: 600,
  trustedBurst: 60,
  globalRatePerHour: 1000,
  globalBurst: 100,
  unusedClientDays: 90,
};

/** How often `startClientCleanup` runs. */
export const CLIENT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const GRANT_TYPES = new Set(["authorization_code", "refresh_token"]);
const NOT_ACCEPTED = new Set(["jwks", "jwks_uri", "sector_identifier_uri"]);
const DROPPED = new Set(["post_logout_redirect_uris"]);

function refuse(description: string): never {
  throw new errors.InvalidClientMetadata(description);
}

/**
 * Runs once per property below, before oidc-provider's own checks, on every
 * client oidc-provider builds. Three rules apply to every client: `DROPPED`
 * goes, a client with a loopback redirect URI is native (see the module
 * comment), and only the bridge's client may hold the device code grant
 * (§8.1). The rest is checked on a registration request only: a stored or
 * CIMD client is built without a `ctx`, and a CIMD client is checked by
 * `cimd.ts`'s `allowClient`.
 */
function validateRegistration(ctx: KoaContextWithOIDC | undefined, key: string, value: unknown, metadata: ClientMetadata): void {
  if (DROPPED.has(key)) {
    delete metadata[key];
    return;
  }
  // A client that sent no application_type has oidc-provider's default, web
  // (native needs no change). Any other value is left for oidc-provider to refuse.
  if (key === "redirect_uris" && (metadata.application_type ?? "web") === "web" && Array.isArray(value) && nativeLoopbackRedirects(value)) {
    metadata.application_type = "native";
  }
  if (ctx?.oidc.route !== "registration") {
    // Registration refuses it below, as it does every grant type but the code flow's.
    if (key === "grant_types" && Array.isArray(value) && value.includes(DEVICE_CODE_GRANT) && metadata.client_id !== BRIDGE_CLIENT_ID) {
      refuse("grant_types may not hold the device code grant: only the Ogre MCP bridge uses it");
    }
    return;
  }
  if (NOT_ACCEPTED.has(key)) {
    if (value !== undefined) refuse(`${key} is not accepted: registered clients are public and have no keys`);
    return;
  }
  // A value of the wrong type is left to oidc-provider, which refuses it.
  switch (key) {
    case "token_endpoint_auth_method":
      // oidc-provider has already put its default, client_secret_basic, in
      // place of a missing value.
      if (ctx.oidc.body?.["token_endpoint_auth_method"] === undefined) metadata.token_endpoint_auth_method = "none";
      else if (value !== "none") refuse("token_endpoint_auth_method must be none: registered clients are public");
      // oidc-provider makes a secret for more than the auth method, such as an
      // HMAC `request_object_signing_alg`. A public client keeps none; a
      // setting that still needs one is then refused.
      delete metadata.client_secret;
      delete metadata.client_secret_expires_at;
      return;
    case "grant_types":
      if (Array.isArray(value) && !value.every((grant) => GRANT_TYPES.has(grant as string))) {
        refuse("grant_types may only hold authorization_code and refresh_token");
      }
      return;
    case "response_types":
      if (Array.isArray(value) && !(value.length > 0 && value.every((type) => type === "code"))) {
        refuse("response_types may only hold code");
      }
      return;
    case "redirect_uris":
      if (Array.isArray(value)) {
        for (const uri of value) {
          if (typeof uri === "string" && !httpsOrLoopback(uri)) refuse("redirect_uris must be https, or http on localhost, 127.0.0.1, or [::1]");
        }
      }
      return;
    case "scope":
      if (typeof value === "string") {
        if (value.split(" ").includes("ingest")) refuse("scope may not hold ingest: registered clients are agents");
        delete metadata.scope;
      }
      return;
  }
}

/** The provider settings for registration. `createOidcProvider` spreads them in. */
export function registrationConfiguration(): {
  settings: Pick<Configuration, "extraClientMetadata">;
  features: Pick<NonNullable<Configuration["features"]>, "registration">;
} {
  return {
    settings: {
      // Standard properties: listed here, the validator runs for them.
      extraClientMetadata: {
        properties: ["token_endpoint_auth_method", "grant_types", "response_types", "redirect_uris", "scope", ...NOT_ACCEPTED, ...DROPPED],
        validator: validateRegistration,
      },
    },
    features: {
      registration: { enabled: true, initialAccessToken: false, issueRegistrationAccessToken: false },
    },
  };
}

/** An address without its zone, and an IPv4-mapped IPv6 address as IPv4. */
function unmapped(ip: string): string {
  const address = ip.split("%")[0] ?? "";
  return /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1] ?? address;
}

/** Most addresses `RegistrationLimiter` keeps a bucket for. */
export const MAX_TRACKED_ADDRESSES = 10_000;

/** How often `RegistrationLimiter` drops the address buckets that have refilled. */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * The registration rate limit: token buckets that each hold `burst` requests
 * and refill at their rate per hour. A request takes one from its own bucket
 * and one from the global bucket, or from neither when either is empty. Its
 * own bucket is its address's (`addressKey`, an IPv6 address by its /64), or
 * the one shared by the trusted ranges.
 *
 * At most `MAX_TRACKED_ADDRESSES` address buckets are kept, and the full
 * ones are dropped once per `SWEEP_INTERVAL_MS`. Past the most, the least
 * recently used one is dropped. An address whose bucket was dropped starts
 * again with a full one; the global bucket still holds.
 */
export class RegistrationLimiter {
  readonly #address: Limit;
  readonly #trusted: Limit;
  readonly #global: Limit;
  readonly #trustedRanges = new BlockList();
  /** In order of last use, least recent first. */
  readonly #addresses = new Map<string, Bucket>();
  #trustedBucket: Bucket | undefined;
  #globalBucket: Bucket | undefined;
  #sweptAt: number;

  constructor(
    settings: RegistrationSettings,
    private readonly now: () => number = Date.now,
  ) {
    this.#address = limit(settings.burst, settings.ratePerHour);
    this.#trusted = limit(settings.trustedBurst, settings.trustedRatePerHour);
    this.#global = limit(settings.globalBurst, settings.globalRatePerHour);
    for (const range of settings.trustedRanges) this.#trustedRanges.addSubnet(range.address, range.prefix, range.family);
    this.#sweptAt = now();
  }

  /** The address buckets kept. */
  get tracked(): number {
    return this.#addresses.size;
  }

  /** Takes one registration from `ip`: 0 when it is allowed, or else the seconds until one will be. */
  take(ip: string): number {
    const now = this.now();
    const trusted = this.#isTrusted(ip);
    const key = addressKey(ip);
    const own = trusted ? this.#trusted : this.#address;
    const ownTokens = level(own, trusted ? this.#trustedBucket : this.#addresses.get(key), now);
    const globalTokens = level(this.#global, this.#globalBucket, now);
    const wait = Math.max(waitSeconds(own, ownTokens), waitSeconds(this.#global, globalTokens));
    if (wait > 0) return wait;
    this.#globalBucket = { tokens: globalTokens - 1, at: now };
    if (trusted) this.#trustedBucket = { tokens: ownTokens - 1, at: now };
    else this.#keep(key, { tokens: ownTokens - 1, at: now }, now);
    return 0;
  }

  #isTrusted(ip: string): boolean {
    const address = unmapped(ip);
    const version = isIP(address);
    return version !== 0 && this.#trustedRanges.check(address, version === 4 ? "ipv4" : "ipv6");
  }

  #keep(key: string, bucket: Bucket, now: number): void {
    this.#addresses.delete(key);
    if (now - this.#sweptAt >= SWEEP_INTERVAL_MS) {
      this.#sweptAt = now;
      for (const [other, kept] of this.#addresses) if (level(this.#address, kept, now) >= this.#address.burst) this.#addresses.delete(other);
    }
    if (this.#addresses.size >= MAX_TRACKED_ADDRESSES) {
      const oldest = this.#addresses.keys().next();
      if (oldest.done !== true) this.#addresses.delete(oldest.value);
    }
    this.#addresses.set(key, bucket);
  }
}

/**
 * oidc-provider's router matches a path whatever its ASCII case, and with one
 * trailing slash. A regular expression with the `i` flag and without `u` folds
 * case the same way.
 */
function routePattern(path: string): RegExp {
  return new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/?$`, "i");
}

export interface RegistrationMiddlewareOptions {
  pool: Pool;
  /** `routes.registration` of the provider. */
  path: string;
  settings: RegistrationSettings;
  log: (line: string) => void;
}

/**
 * Koa middleware for the provider (`provider.use`). It answers a registration
 * request over the limit with 429 and `Retry-After`, and, after the
 * token endpoint issues a token, sets the `last_used_at` of the client and of
 * the token's grant. A failed update is logged, and the token response goes
 * out.
 */
export function registrationMiddleware({ pool, path, settings, log }: RegistrationMiddlewareOptions): Parameters<Provider["use"]>[0] {
  const limiter = new RegistrationLimiter(settings);
  const registration = routePattern(path);
  return async (ctx, next) => {
    if (ctx.method === "POST" && registration.test(ctx.path)) {
      const wait = limiter.take(ctx.ip);
      if (wait > 0) {
        ctx.status = 429;
        ctx.set("Retry-After", String(wait));
        ctx.set("Cache-Control", "no-store");
        ctx.body = { error: "too_many_requests", error_description: "too many client registrations; try again later" };
        return;
      }
    }
    await next();
    // ctx.oidc is defined only on a request oidc-provider routed.
    const oidc = (ctx as Partial<KoaContextWithOIDC>).oidc;
    if (oidc?.route === "token" && ctx.status === 200 && oidc.client !== undefined) {
      try {
        await pool.query(
          "update oidc_models set last_used_at = now() where (model = 'Client' and oidc_id = $1) or (model = 'Grant' and oidc_id = $2)",
          [oidc.client.clientId, oidc.entities.Grant?.jti ?? null],
        );
      } catch (err) {
        log(`oauth client last use not recorded: code=${failureCode(err)}`);
      }
    }
  };
}

/**
 * Deletes the stored clients that have not got a token for `days` days,
 * counted from registration for a client that never got one, and returns how
 * many. Every stored client is a registered one: static clients live in the
 * provider's configuration and CIMD clients are fetched, not stored. A row
 * with neither time is kept.
 *
 * The same statement deletes every other row that names a deleted client in
 * `payload.clientId`: its grants, codes, and tokens. So no access token of a
 * deleted client stays valid, whatever its lifetime.
 */
export async function deleteUnusedClients(pool: Pool, days: number): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    `with clients as (
       delete from oidc_models
        where model = 'Client'
          and coalesce(
                last_used_at,
                case when jsonb_typeof(payload->'client_id_issued_at') = 'number'
                     then to_timestamp((payload->>'client_id_issued_at')::double precision) end
              ) < now() - make_interval(days => $1)
       returning oidc_id
     ), owned as (
       delete from oidc_models
        where model <> 'Client' and payload->>'clientId' in (select oidc_id from clients)
     )
     select count(*)::int as count from clients`,
    [days],
  );
  return rows[0]?.count ?? 0;
}

export interface ClientCleanupOptions {
  pool: Pool;
  /** `OAUTH_CLIENT_UNUSED_DAYS`. */
  unusedClientDays: number;
  /** Receives one line per run that deleted clients. Default: `logger.info`. */
  info?: (line: string) => void;
  /** Receives one line per run that failed. Default: `logger.error`. */
  log?: (line: string) => void;
}

/**
 * Runs `deleteUnusedClients` now and then every `CLIENT_CLEANUP_INTERVAL_MS`
 * in this process, which has no other scheduler. Each replica runs it; the
 * delete is the same on each. The timer does not keep the process alive.
 * Returns a function that stops it.
 */
export function startClientCleanup({ pool, unusedClientDays, info = logger.info, log = logger.error }: ClientCleanupOptions): () => void {
  const run = (): void => {
    deleteUnusedClients(pool, unusedClientDays).then(
      (count) => {
        if (count > 0) info(`deleted ${count} OAuth clients unused for ${unusedClientDays} days`);
      },
      (err: unknown) => log(`unused OAuth client cleanup failed: code=${failureCode(err)}`),
    );
  };
  run();
  const timer = setInterval(run, CLIENT_CLEANUP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
