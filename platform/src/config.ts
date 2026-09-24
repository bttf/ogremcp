/** Everything the platform reads from the environment. `platform/.env.example` lists the names. */
export interface Config {
  port: number;
  /** `DATABASE_URL`. Holds the database password: never logged or repeated. */
  databaseUrl: string;
  /** `DATABASE_QUERY_TIMEOUT_MS`: most time a query waits for the database's answer. */
  databaseQueryTimeoutMs: number;
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

function positiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number of 1 or more`);
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

/**
 * Throws on a value that is missing or wrong, so a bad deploy fails at start
 * and not on the first request. `DATABASE_URL` is required: Postgres is the
 * only store (§11).
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  return {
    port: port(env["PORT"]),
    databaseUrl: databaseUrl(env["DATABASE_URL"]),
    databaseQueryTimeoutMs: positiveInt(
      "DATABASE_QUERY_TIMEOUT_MS",
      env["DATABASE_QUERY_TIMEOUT_MS"],
      DEFAULT_DATABASE_QUERY_TIMEOUT_MS,
    ),
  };
}
