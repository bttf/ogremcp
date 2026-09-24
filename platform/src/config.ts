/** Everything the platform reads from the environment. `platform/.env.example` lists the names. */
export interface Config {
  port: number;
  /** `DATABASE_URL`. Holds the database password: never logged or repeated. */
  databaseUrl: string;
  /** `DATABASE_QUERY_TIMEOUT_MS`: most time a query waits for the database's answer. */
  databaseQueryTimeoutMs: number;
  /**
   * `PUBLIC_BASE_URL`: the origin browsers reach the service at, e.g.
   * `https://ogmcp-production.up.railway.app`, without a trailing slash.
   * Sign-in redirect URIs are built from it, the `Origin` check compares
   * against it, and web session cookies are `Secure` when it is `https`.
   */
  publicBaseUrl: string;
  /** `TRUST_PROXY_HOPS`: proxies in front of the service whose `X-Forwarded-*` headers Express trusts. */
  trustProxyHops: number;
  /** `WEB_SESSION_LIFETIME_DAYS`, in milliseconds: how long a web session lasts after it was last renewed. */
  webSessionLifetimeMs: number;
  /** `WEB_SESSION_RENEW_WITHIN_DAYS`, in milliseconds: a web session used with less than this left is renewed. */
  webSessionRenewWithinMs: number;
  /** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, or null when both are unset. */
  google: ProviderCredentials | null;
  /** `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`, or null when both are unset. */
  discord: ProviderCredentials | null;
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

const DAY_MS = 24 * 60 * 60 * 1000;

function positiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number of 1 or more`);
  return n;
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

/**
 * Throws on a value that is missing or wrong, so a bad deploy fails at start
 * and not on the first request. `DATABASE_URL` is required: Postgres is the
 * only store (§11). The sign-in providers are optional: without one, its
 * routes answer 503.
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
  return {
    port: listenPort,
    databaseUrl: databaseUrl(env["DATABASE_URL"]),
    databaseQueryTimeoutMs: positiveInt(
      "DATABASE_QUERY_TIMEOUT_MS",
      env["DATABASE_QUERY_TIMEOUT_MS"],
      DEFAULT_DATABASE_QUERY_TIMEOUT_MS,
    ),
    publicBaseUrl: publicBaseUrl(env["PUBLIC_BASE_URL"], listenPort, google !== null || discord !== null),
    trustProxyHops: nonNegativeInt("TRUST_PROXY_HOPS", env["TRUST_PROXY_HOPS"], DEFAULT_TRUST_PROXY_HOPS),
    webSessionLifetimeMs: lifetimeDays * DAY_MS,
    webSessionRenewWithinMs: renewWithinDays * DAY_MS,
    google,
    discord,
  };
}
