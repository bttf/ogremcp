import { DatabaseError, Pool } from "pg";

/**
 * The Postgres connection pool, built by `index.ts` from `DATABASE_URL`.
 * Nothing in this module logs or throws the URL, the password, or the text
 * of a Postgres error.
 */

export interface PoolOptions {
  /** `DATABASE_URL`. */
  url: string;
  /** Receives one line per error of an idle connection. Default: `console.error`. */
  log?: (line: string) => void;
  /** Most time a query waits for the database's answer. A query over it fails and its connection is dropped. */
  queryTimeoutMs: number;
  /** Most open connections. Default 5. */
  max?: number;
}

export function createPool({ url, queryTimeoutMs, log = console.error, max = 5 }: PoolOptions): Pool {
  const pool = new Pool({
    connectionString: url,
    max,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    query_timeout: queryTimeoutMs,
  });
  // An idle connection that fails emits here. Without a listener the process
  // would exit, and the default listener would print the message.
  pool.on("error", (err) => {
    log(`database pool error code=${failureCode(err)}`);
  });
  return pool;
}

const CODE = /^[A-Z0-9_]{1,32}$/;

/**
 * The SQLSTATE of a Postgres error, or the `code` of a system error such as
 * `ECONNREFUSED`, and nothing else. The message of a connection error names
 * the host, and a Postgres error's message can repeat a row.
 */
export function failureCode(err: unknown): string {
  if (err instanceof DatabaseError) return err.code ?? "unknown";
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && CODE.test(code) ? code : "unknown";
}
