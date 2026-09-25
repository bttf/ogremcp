import { type CimdFetchLimits, DEFAULT_CIMD_FETCH_LIMITS } from "./cimd.js";
import { DEFAULT_MISSES, type MissSettings } from "./devices.js";
import { DEFAULT_FIRECRAWL_TIMEOUT_MS } from "./firecrawl.js";
import { DEFAULT_INGEST, type IngestSettings } from "./ingest.js";
import { DEFAULT_LOG_LEVEL, isLogLevel, type LogLevel } from "./log.js";
import { defaultMcpAllowedOrigins } from "./mcp.js";
import { type OidcKeys, parseOidcKeys } from "./oidc-keys.js";
import { DEFAULT_REGISTRATION, parseAddressRanges, type RegistrationSettings } from "./oidc-registration.js";
import { DEFAULT_TOKEN_LIFETIMES, type TokenLifetimes } from "./oidc-tokens.js";
import { DEFAULT_RETENTION, type RetentionSettings } from "./retention.js";
import { DEFAULT_SEARCH_CACHE, type SearchCacheSettings } from "./search-cache.js";
import { DEFAULT_TOOL_CONTEXT, type ToolContextSettings } from "./tool-context.js";
import type { ToolCallCaps } from "./usage.js";

/** Everything the platform reads from the environment. `platform/.env.example` lists the names. */
export interface Config {
  port: number;
  /** `DATABASE_URL`. Holds the database password: never logged or repeated. */
  databaseUrl: string;
  /** `DATABASE_QUERY_TIMEOUT_MS`: most time a query waits for the database's answer. */
  databaseQueryTimeoutMs: number;
  /**
   * `PUBLIC_BASE_URL`: the origin browsers reach the service at, e.g.
   * `https://ogremcp.redpine.software`, without a trailing slash.
   * Sign-in redirect URIs are built from it, the `Origin` check compares
   * against it, and web session cookies are `Secure` when it is `https`.
   */
  publicBaseUrl: string;
  /** `TRUST_PROXY_HOPS`: proxies in front of the service whose `X-Forwarded-*` headers Express trusts. */
  trustProxyHops: number;
  /**
   * `MCP_ALLOWED_ORIGINS`: the values the `Origin` header may have on `/mcp`
   * (§9). Unset, `PUBLIC_BASE_URL` and the target clients' web origins.
   */
  mcpAllowedOrigins: string[];
  /** `WEB_SESSION_LIFETIME_DAYS`, in milliseconds: how long a web session lasts after it was last renewed. */
  webSessionLifetimeMs: number;
  /** `WEB_SESSION_RENEW_WITHIN_DAYS`, in milliseconds: a web session used with less than this left is renewed. */
  webSessionRenewWithinMs: number;
  /** The `DCR_` names and `OAUTH_CLIENT_UNUSED_DAYS`: dynamic client registration's limits (§9). */
  registration: RegistrationSettings;
  /** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, or null when both are unset. */
  google: ProviderCredentials | null;
  /** `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`, or null when both are unset. */
  discord: ProviderCredentials | null;
  /**
   * `OIDC_JWKS` and `OIDC_COOKIE_KEYS`, the OAuth server's keys (§13.1), or
   * null when both are unset. Never logged or repeated.
   */
  oidcKeys: OidcKeys | null;
  /**
   * `OAUTH_ACCESS_TOKEN_LIFETIME_MINUTES`, `OAUTH_REFRESH_TOKEN_LIFETIME_DAYS`,
   * and `OAUTH_GRANT_LIFETIME_DAYS`, in seconds (§9).
   */
  tokenLifetimes: TokenLifetimes;
  /**
   * `CIMD_FETCHES_PER_MINUTE`, `CIMD_FETCHES_PER_HOST_PER_MINUTE`,
   * `CIMD_FETCHES_PER_IP_PER_MINUTE`, and `CIMD_TRUSTED_CLIENT_IDS`: the limits on
   * the OAuth server's fetches of client ID metadata documents and client
   * JWKS (§9, `cimd.ts`). Each one unset is `DEFAULT_CIMD_FETCH_LIMITS`'s.
   */
  cimdFetchLimits: CimdFetchLimits;
  /**
   * `DEVICE_CODE_MISS_RATE_PER_HOUR`, `DEVICE_CODE_MISS_BURST`,
   * `DEVICE_CODE_MISS_GLOBAL_RATE_PER_HOUR`, and
   * `DEVICE_CODE_MISS_GLOBAL_BURST`: the limits on user codes entered at
   * `/device` that match no bridge (§8.1, `devices.ts`). Each one unset is
   * `DEFAULT_MISSES`'s.
   */
  deviceCodeMisses: MissSettings;
  /**
   * `INGEST_MAX_UNCOMPRESSED_BYTES`, the cap on an upload's uncompressed
   * bytes; `INGEST_RATE_PER_MINUTE` and `INGEST_BURST`, the rate limit per
   * device and source instance; `INGEST_DEVICE_RATE_PER_MINUTE` and
   * `INGEST_DEVICE_BURST`, the rate limit per device (§8.3, `ingest.ts`); and
   * `DEVICES_PER_USER_FREE` and `DEVICES_PER_USER_PAID`, the device limit of
   * each tier (§8.3, §14). Each one unset is `DEFAULT_INGEST`'s: one device
   * on the free tier, and no limit on the paid tier. `DEVICES_PER_USER_FREE`
   * `off` is no limit.
   */
  ingest: IngestSettings;
  /**
   * `HISTORY_MAX_SNAPSHOTS`: the most snapshots a kit tool's history read
   * returns (§6.2, `tool-context.ts`). `TOOL_RESULT_MAX_BYTES`: the cap on
   * one copy of a kit tool result's JSON (§10.5, `tool-envelope.ts`).
   * `LIST_GAMES_CHARACTERS`: the most recent characters `list_games` returns
   * per game (§10.3, `list-games.ts`). `FETCH_PAGE_MAX_CHARS`: the most
   * characters of a page `fetch_game_page` returns (§10.3,
   * `fetch-game-page.ts`). `REPORT_ISSUE_MAX_PER_DAY`: the most reports
   * `report_issue` records per user in 24 hours, and `REPORT_ISSUE_CALLS`:
   * the most recent tool calls a report attaches (§16.2, `report-issue.ts`).
   * Each one unset is `DEFAULT_TOOL_CONTEXT`'s.
   */
  toolContext: ToolContextSettings;
  /**
   * `FIRECRAWL_API_KEY`, the search provider's key (§12), or null when it is
   * unset: `search_game_info` and `fetch_game_page` then answer
   * `search_unavailable`. Never logged or repeated. `FIRECRAWL_TIMEOUT_MS`:
   * the most time one Firecrawl request takes. Unset,
   * `DEFAULT_FIRECRAWL_TIMEOUT_MS`.
   */
  firecrawl: { apiKey: string | null; timeoutMs: number };
  /**
   * `SEARCH_CACHE_TTL_DAYS` and `SEARCH_CACHE_EMPTY_TTL_MINUTES`, in
   * milliseconds: how long the shared cache keeps a search or page, and an
   * empty answer (§12, `search-cache.ts`). Each one unset is
   * `DEFAULT_SEARCH_CACHE`'s.
   */
  searchCache: SearchCacheSettings;
  /**
   * `TOOL_CALLS_PER_DAY_FREE` and `TOOL_CALLS_PER_DAY_PAID`: the most MCP
   * tool calls a user of each tier makes per UTC day (§14, `usage.ts`). Each
   * one unset is null: no cap. The calls are counted either way.
   */
  toolCallCaps: ToolCallCaps;
  /**
   * `FREE_RETENTION_DAYS`: how many days of uploads and snapshots a free user
   * keeps, or `off`: forever. `DOWNGRADE_GRACE_DAYS`: how many days after a
   * downgrade to free a user keeps all their history (§11, §19.1 D9,
   * `retention.ts`). Each one unset is `DEFAULT_RETENTION`'s, and at most
   * 36500.
   */
  retention: RetentionSettings;
  /**
   * `BRIDGE_DOWNLOAD_URL`: where the Get started page sends people to
   * download the bridge (§7, §13.2), or null when it is unset. The page then
   * says the download is not available yet.
   */
  bridgeDownloadUrl: string | null;
  /**
   * `CONTACT_EMAIL`: the address the Privacy and Terms pages give for
   * questions (§13.2), or null when it is unset. The pages then say contact
   * details are coming soon.
   */
  contactEmail: string | null;
  /**
   * `ADMIN_USER_UUIDS`: the `users.uuid` of each user who may open `/admin`
   * (§13.2, `admin.ts`), in lower case. Empty when it is unset: nobody may.
   */
  adminUserUuids: string[];
  /** `LOG_LEVEL`: the least severe level the log writes (§16). Unset, `info`. */
  logLevel: LogLevel;
  /** Whether `NODE_ENV` is `production`. Railpack sets it on Railway. */
  production: boolean;
}

export interface ProviderCredentials {
  clientId: string;
  /** Never logged or repeated. */
  clientSecret: string;
}

/**
 * The local port when `PORT` is unset. Not 3000, 3001, 5173, or 8080: those
 * are defaults of common frameworks, and another app on the machine takes
 * them. Railway always sets `PORT`.
 */
export const DEFAULT_PORT = 4790;

/**
 * The query timeout when `DATABASE_QUERY_TIMEOUT_MS` is unset. Without one, a
 * query on a connection the database no longer answers waits for the socket
 * to fail, which can take minutes, and `/health` stays degraded that long.
 */
export const DEFAULT_DATABASE_QUERY_TIMEOUT_MS = 5_000;

/**
 * No proxy is trusted unless configured. Railway sets 1: its edge is one
 * proxy in front of the service, and it terminates TLS.
 */
export const DEFAULT_TRUST_PROXY_HOPS = 0;

/** Web session lifetime and renewal window, after the Lucia sessions guide. */
export const DEFAULT_WEB_SESSION_LIFETIME_DAYS = 30;
export const DEFAULT_WEB_SESSION_RENEW_WITHIN_DAYS = 15;

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const DAY_SECONDS = 24 * 60 * 60;

/** The largest Postgres `integer`. A count or cap that reaches the database as one must fit it. */
const INT_MAX = 2_147_483_647;

/**
 * The most days a retention setting takes: 100 years. The retention job
 * subtracts them from the current time, which stays in Postgres's range.
 */
const MAX_DAYS = 36_500;

function positiveInt(name: string, value: string | undefined, fallback: number, max = INT_MAX): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number of 1 or more`);
  if (n > max) throw new Error(`${name} must be at most ${max}`);
  return n;
}

/**
 * A limit that `off` or 0 turns off: a whole number from 1 to `max`, or null
 * for off. Unset is `fallback`. A self-host sets it off (§13.3).
 */
function limitOrOff(name: string, value: string | undefined, fallback: number | null, max = INT_MAX): number | null {
  const raw = (value ?? "").trim().toLowerCase();
  if (raw === "") return fallback;
  if (raw === "off" || Number(raw) === 0) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${name} must be off or a whole number from 1 to ${max}`);
  return n;
}

/** A whole number of 1 or more, or null when unset. */
function optionalPositiveInt(name: string, value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  return positiveInt(name, value, 1);
}

function nonNegativeInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number of 0 or more`);
  return n;
}

/** 0 lets the system pick a free port; the start line reports it. */
function port(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_PORT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error("PORT must be a whole number from 0 to 65535");
  return n;
}

/**
 * `DATABASE_URL`, checked here so that a bad value fails at start. No error
 * repeats the URL or any part of it. TLS follows the URL's `sslmode`, as pg
 * reads it: Railway's private network URL has none and connects without TLS.
 * A database reached over the internet needs `sslmode=verify-full`.
 */
function databaseUrl(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (raw === "") throw new Error("DATABASE_URL must be set");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL is not a URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("DATABASE_URL must start with postgresql://");
  }
  if (url.hostname === "") throw new Error("DATABASE_URL names no host");
  if (url.pathname === "/" || url.pathname === "") throw new Error("DATABASE_URL names no database");
  return raw;
}

/** Both names of a provider set, or neither. A value is never repeated. */
function credentials(idName: string, secretName: string, env: Record<string, string | undefined>): ProviderCredentials | null {
  const clientId = (env[idName] ?? "").trim();
  const clientSecret = (env[secretName] ?? "").trim();
  if (clientId === "" && clientSecret === "") return null;
  if (clientId === "" || clientSecret === "") throw new Error(`${idName} and ${secretName} must be set together`);
  return { clientId, clientSecret };
}

/**
 * `PUBLIC_BASE_URL`, as an origin. Unset, it is `http://localhost:<PORT>`,
 * which is only right on the local machine, so it must be set whenever a
 * sign-in provider is: a deployed service would otherwise send people back to
 * localhost after sign-in and set cookies without `Secure`.
 */
function publicBaseUrl(value: string | undefined, localPort: number, providerSet: boolean): string {
  const raw = (value ?? "").trim();
  if (raw === "") {
    if (providerSet) throw new Error("PUBLIC_BASE_URL must be set when a sign-in provider is configured");
    return `http://localhost:${localPort}`;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PUBLIC_BASE_URL is not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("PUBLIC_BASE_URL must start with https:// or http://");
  if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    throw new Error("PUBLIC_BASE_URL must be an origin only, such as https://example.com");
  }
  return url.origin;
}

/** The OAuth token lifetimes. A refresh token may not outlast its grant. */
function tokenLifetimes(env: Record<string, string | undefined>): TokenLifetimes {
  const accessMinutes = positiveInt(
    "OAUTH_ACCESS_TOKEN_LIFETIME_MINUTES",
    env["OAUTH_ACCESS_TOKEN_LIFETIME_MINUTES"],
    DEFAULT_TOKEN_LIFETIMES.accessTokenSeconds / 60,
  );
  const refreshDays = positiveInt(
    "OAUTH_REFRESH_TOKEN_LIFETIME_DAYS",
    env["OAUTH_REFRESH_TOKEN_LIFETIME_DAYS"],
    DEFAULT_TOKEN_LIFETIMES.refreshTokenSeconds / DAY_SECONDS,
  );
  const grantDays = positiveInt("OAUTH_GRANT_LIFETIME_DAYS", env["OAUTH_GRANT_LIFETIME_DAYS"], DEFAULT_TOKEN_LIFETIMES.grantSeconds / DAY_SECONDS);
  if (refreshDays > grantDays) throw new Error("OAUTH_REFRESH_TOKEN_LIFETIME_DAYS must not be more than OAUTH_GRANT_LIFETIME_DAYS");
  return { accessTokenSeconds: accessMinutes * 60, refreshTokenSeconds: refreshDays * DAY_SECONDS, grantSeconds: grantDays * DAY_SECONDS };
}

/**
 * `MCP_ALLOWED_ORIGINS`, comma-separated. Each entry must be an origin exactly
 * as a browser sends it, such as `https://claude.ai`: lowercase, no path, no
 * default port, no wildcard. A set value replaces the default list.
 */
function mcpAllowedOrigins(value: string | undefined, fallback: string[]): string[] {
  const raw = (value ?? "").trim();
  if (raw === "") return fallback;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      let origin: string;
      try {
        origin = new URL(entry).origin;
      } catch {
        origin = "null";
      }
      // `*` is a valid host character for the URL parser, so a wildcard would pass as a literal host.
      if (origin !== entry || entry.includes("*")) throw new Error("MCP_ALLOWED_ORIGINS must list origins only, such as https://claude.ai");
      return entry;
    });
}

/** The registration limits. `DCR_TRUSTED_RANGES` is a comma-separated list of CIDR ranges. */
function registrationSettings(env: Record<string, string | undefined>): RegistrationSettings {
  const d = DEFAULT_REGISTRATION;
  const ranges = (env["DCR_TRUSTED_RANGES"] ?? "").trim();
  return {
    ratePerHour: positiveInt("DCR_RATE_PER_HOUR", env["DCR_RATE_PER_HOUR"], d.ratePerHour),
    burst: positiveInt("DCR_BURST", env["DCR_BURST"], d.burst),
    trustedRanges: ranges === "" ? d.trustedRanges : parseAddressRanges("DCR_TRUSTED_RANGES", ranges),
    trustedRatePerHour: positiveInt("DCR_TRUSTED_RATE_PER_HOUR", env["DCR_TRUSTED_RATE_PER_HOUR"], d.trustedRatePerHour),
    trustedBurst: positiveInt("DCR_TRUSTED_BURST", env["DCR_TRUSTED_BURST"], d.trustedBurst),
    globalRatePerHour: positiveInt("DCR_GLOBAL_RATE_PER_HOUR", env["DCR_GLOBAL_RATE_PER_HOUR"], d.globalRatePerHour),
    globalBurst: positiveInt("DCR_GLOBAL_BURST", env["DCR_GLOBAL_BURST"], d.globalBurst),
    unusedClientDays: positiveInt("OAUTH_CLIENT_UNUSED_DAYS", env["OAUTH_CLIENT_UNUSED_DAYS"], d.unusedClientDays),
  };
}

/**
 * `CIMD_TRUSTED_CLIENT_IDS`, comma-separated. Each entry must be an https
 * `client_id` URL exactly as a URL parser writes it, such as
 * `https://claude.ai/oauth/mcp-oauth-client-metadata`: only a request with
 * that exact `client_id` is trusted. A set value replaces the default list.
 */
function cimdTrustedClientIds(value: string | undefined): readonly string[] {
  const raw = (value ?? "").trim();
  if (raw === "") return DEFAULT_CIMD_FETCH_LIMITS.trustedClientIds;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const url = URL.parse(entry);
      if (url?.protocol !== "https:" || url.href !== entry) {
        throw new Error("CIMD_TRUSTED_CLIENT_IDS must list https client_id URLs, such as https://claude.ai/oauth/mcp-oauth-client-metadata");
      }
      return entry;
    });
}

/**
 * `BRIDGE_DOWNLOAD_URL`, as an https URL. The web UI puts it in a link, so
 * any other scheme, such as `javascript:`, is refused.
 */
function bridgeDownloadUrl(value: string | undefined): string | null {
  const raw = (value ?? "").trim();
  if (raw === "") return null;
  const url = URL.parse(raw);
  if (url?.protocol !== "https:") throw new Error("BRIDGE_DOWNLOAD_URL must be an https URL");
  return url.href;
}

/**
 * A plain email address: no spaces, quotes, `%`, `?`, or `#`. The web UI puts
 * it in a `mailto:` link, where those would change the link.
 */
const EMAIL = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/** `CONTACT_EMAIL`, as a plain email address of at most 254 characters. */
function contactEmail(value: string | undefined): string | null {
  const raw = (value ?? "").trim();
  if (raw === "") return null;
  if (raw.length > 254 || !EMAIL.test(raw)) throw new Error("CONTACT_EMAIL must be an email address, such as privacy@example.com");
  return raw;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `ADMIN_USER_UUIDS`, comma-separated, in lower case as Postgres writes a
 * uuid. Unset or empty, nobody is an admin.
 */
function adminUserUuids(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "")
    .map((entry) => {
      if (!UUID.test(entry)) throw new Error("ADMIN_USER_UUIDS must list user uuids, comma-separated");
      return entry;
    });
}

/** `LOG_LEVEL`, in any case. */
function logLevel(value: string | undefined): LogLevel {
  const raw = (value ?? "").trim().toLowerCase();
  if (raw === "") return DEFAULT_LOG_LEVEL;
  if (!isLogLevel(raw)) throw new Error("LOG_LEVEL must be debug, info, warn, or error");
  return raw;
}

/**
 * Throws on a value that is missing or wrong, so a bad deploy fails at start
 * and not on the first request. `DATABASE_URL` is required: Postgres is the
 * only store (§11). The sign-in providers are optional: without one, its
 * routes answer 503. The OAuth server's keys may be unset here; `index.ts`
 * decides whether the service may start without them.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const listenPort = port(env["PORT"]);
  const google = credentials("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", env);
  const discord = credentials("DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", env);
  const lifetimeDays = positiveInt("WEB_SESSION_LIFETIME_DAYS", env["WEB_SESSION_LIFETIME_DAYS"], DEFAULT_WEB_SESSION_LIFETIME_DAYS);
  const renewWithinDays = positiveInt(
    "WEB_SESSION_RENEW_WITHIN_DAYS",
    env["WEB_SESSION_RENEW_WITHIN_DAYS"],
    Math.min(DEFAULT_WEB_SESSION_RENEW_WITHIN_DAYS, lifetimeDays),
  );
  if (renewWithinDays > lifetimeDays) throw new Error("WEB_SESSION_RENEW_WITHIN_DAYS must not be more than WEB_SESSION_LIFETIME_DAYS");
  const baseUrl = publicBaseUrl(env["PUBLIC_BASE_URL"], listenPort, google !== null || discord !== null);
  return {
    port: listenPort,
    databaseUrl: databaseUrl(env["DATABASE_URL"]),
    databaseQueryTimeoutMs: positiveInt(
      "DATABASE_QUERY_TIMEOUT_MS",
      env["DATABASE_QUERY_TIMEOUT_MS"],
      DEFAULT_DATABASE_QUERY_TIMEOUT_MS,
    ),
    publicBaseUrl: baseUrl,
    trustProxyHops: nonNegativeInt("TRUST_PROXY_HOPS", env["TRUST_PROXY_HOPS"], DEFAULT_TRUST_PROXY_HOPS),
    mcpAllowedOrigins: mcpAllowedOrigins(env["MCP_ALLOWED_ORIGINS"], defaultMcpAllowedOrigins(baseUrl)),
    webSessionLifetimeMs: lifetimeDays * DAY_MS,
    webSessionRenewWithinMs: renewWithinDays * DAY_MS,
    registration: registrationSettings(env),
    google,
    discord,
    oidcKeys: parseOidcKeys(env["OIDC_JWKS"], env["OIDC_COOKIE_KEYS"]),
    tokenLifetimes: tokenLifetimes(env),
    cimdFetchLimits: {
      perMinute: positiveInt("CIMD_FETCHES_PER_MINUTE", env["CIMD_FETCHES_PER_MINUTE"], DEFAULT_CIMD_FETCH_LIMITS.perMinute),
      perHostPerMinute: positiveInt(
        "CIMD_FETCHES_PER_HOST_PER_MINUTE",
        env["CIMD_FETCHES_PER_HOST_PER_MINUTE"],
        DEFAULT_CIMD_FETCH_LIMITS.perHostPerMinute,
      ),
      perIpPerMinute: positiveInt(
        "CIMD_FETCHES_PER_IP_PER_MINUTE",
        env["CIMD_FETCHES_PER_IP_PER_MINUTE"],
        DEFAULT_CIMD_FETCH_LIMITS.perIpPerMinute,
      ),
      trustedClientIds: cimdTrustedClientIds(env["CIMD_TRUSTED_CLIENT_IDS"]),
    },
    deviceCodeMisses: {
      ratePerHour: positiveInt("DEVICE_CODE_MISS_RATE_PER_HOUR", env["DEVICE_CODE_MISS_RATE_PER_HOUR"], DEFAULT_MISSES.ratePerHour),
      burst: positiveInt("DEVICE_CODE_MISS_BURST", env["DEVICE_CODE_MISS_BURST"], DEFAULT_MISSES.burst),
      globalRatePerHour: positiveInt(
        "DEVICE_CODE_MISS_GLOBAL_RATE_PER_HOUR",
        env["DEVICE_CODE_MISS_GLOBAL_RATE_PER_HOUR"],
        DEFAULT_MISSES.globalRatePerHour,
      ),
      globalBurst: positiveInt("DEVICE_CODE_MISS_GLOBAL_BURST", env["DEVICE_CODE_MISS_GLOBAL_BURST"], DEFAULT_MISSES.globalBurst),
    },
    ingest: {
      maxBytes: positiveInt("INGEST_MAX_UNCOMPRESSED_BYTES", env["INGEST_MAX_UNCOMPRESSED_BYTES"], DEFAULT_INGEST.maxBytes),
      ratePerMinute: positiveInt("INGEST_RATE_PER_MINUTE", env["INGEST_RATE_PER_MINUTE"], DEFAULT_INGEST.ratePerMinute),
      burst: positiveInt("INGEST_BURST", env["INGEST_BURST"], DEFAULT_INGEST.burst),
      deviceRatePerMinute: positiveInt(
        "INGEST_DEVICE_RATE_PER_MINUTE",
        env["INGEST_DEVICE_RATE_PER_MINUTE"],
        DEFAULT_INGEST.deviceRatePerMinute,
      ),
      deviceBurst: positiveInt("INGEST_DEVICE_BURST", env["INGEST_DEVICE_BURST"], DEFAULT_INGEST.deviceBurst),
      devicesPerUser: {
        free: limitOrOff("DEVICES_PER_USER_FREE", env["DEVICES_PER_USER_FREE"], DEFAULT_INGEST.devicesPerUser.free),
        paid: optionalPositiveInt("DEVICES_PER_USER_PAID", env["DEVICES_PER_USER_PAID"]),
      },
    },
    toolContext: {
      maxHistoryLimit: positiveInt("HISTORY_MAX_SNAPSHOTS", env["HISTORY_MAX_SNAPSHOTS"], DEFAULT_TOOL_CONTEXT.maxHistoryLimit),
      maxResultBytes: positiveInt("TOOL_RESULT_MAX_BYTES", env["TOOL_RESULT_MAX_BYTES"], DEFAULT_TOOL_CONTEXT.maxResultBytes),
      listGamesCharacters: positiveInt("LIST_GAMES_CHARACTERS", env["LIST_GAMES_CHARACTERS"], DEFAULT_TOOL_CONTEXT.listGamesCharacters),
      fetchPageMaxChars: positiveInt("FETCH_PAGE_MAX_CHARS", env["FETCH_PAGE_MAX_CHARS"], DEFAULT_TOOL_CONTEXT.fetchPageMaxChars),
      reportIssueMaxPerDay: positiveInt("REPORT_ISSUE_MAX_PER_DAY", env["REPORT_ISSUE_MAX_PER_DAY"], DEFAULT_TOOL_CONTEXT.reportIssueMaxPerDay),
      reportIssueCalls: positiveInt("REPORT_ISSUE_CALLS", env["REPORT_ISSUE_CALLS"], DEFAULT_TOOL_CONTEXT.reportIssueCalls),
    },
    firecrawl: {
      apiKey: (env["FIRECRAWL_API_KEY"] ?? "").trim() || null,
      timeoutMs: positiveInt("FIRECRAWL_TIMEOUT_MS", env["FIRECRAWL_TIMEOUT_MS"], DEFAULT_FIRECRAWL_TIMEOUT_MS),
    },
    searchCache: {
      ttlMs: positiveInt("SEARCH_CACHE_TTL_DAYS", env["SEARCH_CACHE_TTL_DAYS"], DEFAULT_SEARCH_CACHE.ttlMs / DAY_MS) * DAY_MS,
      emptyTtlMs:
        positiveInt("SEARCH_CACHE_EMPTY_TTL_MINUTES", env["SEARCH_CACHE_EMPTY_TTL_MINUTES"], DEFAULT_SEARCH_CACHE.emptyTtlMs / MINUTE_MS) * MINUTE_MS,
    },
    toolCallCaps: {
      free: optionalPositiveInt("TOOL_CALLS_PER_DAY_FREE", env["TOOL_CALLS_PER_DAY_FREE"]),
      paid: optionalPositiveInt("TOOL_CALLS_PER_DAY_PAID", env["TOOL_CALLS_PER_DAY_PAID"]),
    },
    retention: {
      freeRetentionDays: limitOrOff("FREE_RETENTION_DAYS", env["FREE_RETENTION_DAYS"], DEFAULT_RETENTION.freeRetentionDays, MAX_DAYS),
      downgradeGraceDays: positiveInt("DOWNGRADE_GRACE_DAYS", env["DOWNGRADE_GRACE_DAYS"], DEFAULT_RETENTION.downgradeGraceDays, MAX_DAYS),
    },
    bridgeDownloadUrl: bridgeDownloadUrl(env["BRIDGE_DOWNLOAD_URL"]),
    contactEmail: contactEmail(env["CONTACT_EMAIL"]),
    adminUserUuids: adminUserUuids(env["ADMIN_USER_UUIDS"]),
    logLevel: logLevel(env["LOG_LEVEL"]),
    production: env["NODE_ENV"] === "production",
  };
}
