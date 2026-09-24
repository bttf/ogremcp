import type Provider from "oidc-provider";
import { type ClientMetadata, type Configuration, errors, type KoaContextWithOIDC } from "oidc-provider";
import type { Pool } from "pg";

import { failureCode } from "./db.js";

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
 *   `127.0.0.1`, or `[::1]`. The port must match exactly (RED-308).
 * - `scope` may not name `ingest`, the bridge scope (§8.1). Other values are
 *   accepted and not stored: oidc-provider checks a client's `scope` against
 *   its own scopes only, and `read` is the MCP server's resource scope, not
 *   one of those. What an agent client is granted is set at authorization
 *   (RED-302). Claude has sent scopes the server does not define, such as
 *   `claudeai`, so an unknown value is dropped, not refused.
 * - `jwks`, `jwks_uri`, and `sector_identifier_uri` are refused. A public
 *   client has no keys, and oidc-provider would fetch `sector_identifier_uri`
 *   from this server at registration.
 *
 * No registration access token is issued, and registration management
 * (RFC 7592) is off: a client cannot read, change, or delete its registration.
 *
 * The endpoint is rate-limited per client address, with a token bucket. The
 * buckets are in memory: they start full when the process starts, and each
 * replica keeps its own.
 *
 * Each time the token endpoint issues a client a token, its row's
 * `last_used_at` is set (migration 0004). `startClientCleanup` deletes the
 * clients that have not got a token for `unusedClientDays`. The token
 * endpoint then answers `401 invalid_client` for them, which tells Claude to
 * register again.
 */

/** The registration limits (*proposed*, §0). `config.ts` reads them from the environment. */
export interface RegistrationSettings {
  /** `OAUTH_REGISTRATION_RATE_PER_HOUR`: registrations one address may make per hour once its burst is spent. */
  ratePerHour: number;
  /** `OAUTH_REGISTRATION_BURST`: registrations one address may make at once. */
  burst: number;
  /**
   * `OAUTH_CLIENT_UNUSED_DAYS`: a registered client that has not got a token
   * for this many days is deleted. A client that never got one counts from
   * its registration.
   */
  unusedClientDays: number;
}

export const DEFAULT_REGISTRATION: RegistrationSettings = {
  ratePerHour: 10,
  burst: 5,
  unusedClientDays: 90,
};

/** How often `startClientCleanup` runs. */
export const CLIENT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

const GRANT_TYPES = new Set(["authorization_code", "refresh_token"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const NOT_ACCEPTED = new Set(["jwks", "jwks_uri", "sector_identifier_uri"]);

function refuse(description: string): never {
  throw new errors.InvalidClientMetadata(description);
}

/**
 * Runs once per property below, before oidc-provider's own checks, on every
 * client oidc-provider builds. Only a registration request is checked: a
 * stored client loads without a `ctx`.
 */
function validateRegistration(ctx: KoaContextWithOIDC | undefined, key: string, value: unknown, metadata: ClientMetadata): void {
  if (ctx?.oidc.route !== "registration") return;
  if (NOT_ACCEPTED.has(key)) {
    if (value !== undefined) refuse(`${key} is not accepted: registered clients are public and have no keys`);
    return;
  }
  // A value of the wrong type is left to oidc-provider, which refuses it.
  switch (key) {
    case "token_endpoint_auth_method":
      // oidc-provider has already put its default, client_secret_basic, in
      // place of a missing value, and made a secret for it.
      if (ctx.oidc.body?.["token_endpoint_auth_method"] === undefined) {
        metadata.token_endpoint_auth_method = "none";
        delete metadata.client_secret;
        delete metadata.client_secret_expires_at;
      } else if (value !== "none") {
        refuse("token_endpoint_auth_method must be none: registered clients are public");
      }
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
          if (typeof uri !== "string") continue;
          const url = URL.parse(uri);
          const ok = url !== null && (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)));
          if (!ok) refuse("redirect_uris must be https, or http on localhost, 127.0.0.1, or [::1]");
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
        properties: ["token_endpoint_auth_method", "grant_types", "response_types", "redirect_uris", "scope", ...NOT_ACCEPTED],
        validator: validateRegistration,
      },
    },
    features: {
      registration: { enabled: true, initialAccessToken: false, issueRegistrationAccessToken: false },
    },
  };
}

/**
 * The key a client address is limited by: an IPv4 address, or the /64 of an
 * IPv6 address, since one host usually holds a whole /64.
 */
export function addressKey(ip: string): string {
  const address = ip.split("%")[0] ?? "";
  if (!address.includes(":")) return address;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1] !== undefined) return mapped[1];
  const [head = "", tail] = address.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(":")}::/64`;
}

/** Past this many addresses, `RateLimiter` drops the buckets that have refilled. */
const MAX_TRACKED = 10_000;

/** A token bucket per key: `burst` requests at once, refilled at `ratePerHour`. */
export class RateLimiter {
  readonly #buckets = new Map<string, { tokens: number; at: number }>();
  readonly #perMs: number;

  constructor(
    private readonly burst: number,
    ratePerHour: number,
    private readonly now: () => number = Date.now,
  ) {
    this.#perMs = ratePerHour / HOUR_MS;
  }

  /** Takes one request for `key`: 0 when it is allowed, or else the seconds until one will be. */
  take(key: string): number {
    const now = this.now();
    const tokens = this.#tokens(this.#buckets.get(key), now);
    if (tokens < 1) return Math.ceil((1 - tokens) / this.#perMs / 1000);
    this.#buckets.set(key, { tokens: tokens - 1, at: now });
    if (this.#buckets.size > MAX_TRACKED) {
      for (const [other, bucket] of this.#buckets) if (this.#tokens(bucket, now) >= this.burst) this.#buckets.delete(other);
    }
    return 0;
  }

  #tokens(bucket: { tokens: number; at: number } | undefined, now: number): number {
    return bucket === undefined ? this.burst : Math.min(this.burst, bucket.tokens + (now - bucket.at) * this.#perMs);
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
 * request over the address's limit with 429 and `Retry-After`, and, after the
 * token endpoint issues a token, sets the client's `last_used_at`. A failed
 * update is logged, and the token response goes out.
 */
export function registrationMiddleware({ pool, path, settings, log }: RegistrationMiddlewareOptions): Parameters<Provider["use"]>[0] {
  const limiter = new RateLimiter(settings.burst, settings.ratePerHour);
  const registration = routePattern(path);
  return async (ctx, next) => {
    if (ctx.method === "POST" && registration.test(ctx.path)) {
      const wait = limiter.take(addressKey(ctx.ip));
      if (wait > 0) {
        ctx.status = 429;
        ctx.set("Retry-After", String(wait));
        ctx.set("Cache-Control", "no-store");
        ctx.body = { error: "too_many_requests", error_description: "too many client registrations from this address; try again later" };
        return;
      }
    }
    await next();
    // ctx.oidc is defined only on a request oidc-provider routed.
    const oidc = (ctx as Partial<KoaContextWithOIDC>).oidc;
    if (oidc?.route === "token" && ctx.status === 200 && oidc.client !== undefined) {
      try {
        await pool.query("update oidc_models set last_used_at = now() where model = 'Client' and oidc_id = $1", [oidc.client.clientId]);
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
 */
export async function deleteUnusedClients(pool: Pool, days: number): Promise<number> {
  const { rowCount } = await pool.query(
    `delete from oidc_models
      where model = 'Client'
        and coalesce(
              last_used_at,
              case when jsonb_typeof(payload->'client_id_issued_at') = 'number'
                   then to_timestamp((payload->>'client_id_issued_at')::double precision) end
            ) < now() - make_interval(days => $1)`,
    [days],
  );
  return rowCount ?? 0;
}

export interface ClientCleanupOptions {
  pool: Pool;
  /** `OAUTH_CLIENT_UNUSED_DAYS`. */
  unusedClientDays: number;
  /** Receives one line per run that deleted clients. Default: `console.log`. */
  info?: (line: string) => void;
  /** Receives one line per run that failed. Default: `console.error`. */
  log?: (line: string) => void;
}

/**
 * Runs `deleteUnusedClients` now and then every `CLIENT_CLEANUP_INTERVAL_MS`
 * in this process, which has no other scheduler. Each replica runs it; the
 * delete is the same on each. The timer does not keep the process alive.
 * Returns a function that stops it.
 */
export function startClientCleanup({ pool, unusedClientDays, info = console.log, log = console.error }: ClientCleanupOptions): () => void {
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
