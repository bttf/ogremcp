import type { Pool } from "pg";

import { failureCode } from "./db.js";
import { logger } from "./log.js";

/**
 * The cleanup of expired auth rows (§11): oidc-provider's rows in
 * `oidc_models` (migration 0003) past their `expires_at`, and `web_sessions`
 * rows past theirs. `startAuthCleanup` runs it at start and once a day, on
 * every deployment, a self-host too: these rows are sign-ins and tokens, not
 * a user's history.
 *
 * - A row with no expiry, such as a client, is never deleted here. Unused
 *   clients have a job of their own (`startClientCleanup`).
 * - A row goes once `expires_at <= now()`, with no margin. The adapter
 *   (`oidc-adapter.ts`) returns no row past its `expires_at`, by the same
 *   database clock, so oidc-provider already sees such a row as gone. Its
 *   lookups with `ignoreExpiration`, as for a refresh token or a code, read
 *   an expired row only to name the error, and never get one.
 *   `WebSessions.validate` treats an expired web session as gone too.
 * - Each batch is one statement that deletes up to `batchSize` rows of one
 *   table, and locks them `for update skip locked`: two instances that run
 *   at once during a deploy take different rows, and a row another
 *   transaction holds is skipped, not waited for. The batches run one after
 *   another until one finds fewer rows than that.
 * - Each run logs one line with the rows it deleted, by table, and no row
 *   data. A run that fails logs its code and the rows it deleted before the
 *   failure.
 */

/** How often `startAuthCleanup` runs. */
export const AUTH_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The most rows one batch deletes. */
export const AUTH_CLEANUP_BATCH = 500;

/** The rows a run deleted, by table. */
export interface DeletedAuthRows {
  oidc_models: number;
  web_sessions: number;
}

const TABLES = ["oidc_models", "web_sessions"] as const;

/** One batch of `table`. `$1` is the batch size. A null `expires_at` never matches. */
function deleteBatch(table: keyof DeletedAuthRows): string {
  return `
    with expired as (
      select id from ${table} where expires_at <= now() limit $1 for update skip locked
    )
    delete from ${table} where id in (select id from expired)`;
}

export interface AuthCleanupOptions {
  pool: Pool;
  /** Default: `AUTH_CLEANUP_BATCH`. */
  batchSize?: number;
}

/**
 * Deletes the expired rows of `oidc_models` and `web_sessions`, in batches,
 * and logs one line. Throws on the first batch that fails, after its line;
 * the batches before it stay deleted.
 */
export async function deleteExpiredAuthRows({ pool, batchSize = AUTH_CLEANUP_BATCH }: AuthCleanupOptions): Promise<DeletedAuthRows> {
  const deleted: DeletedAuthRows = { oidc_models: 0, web_sessions: 0 };
  try {
    for (const table of TABLES) {
      for (;;) {
        const count = (await pool.query(deleteBatch(table), [batchSize])).rowCount ?? 0;
        deleted[table] += count;
        if (count < batchSize) break;
      }
    }
  } catch (err) {
    logger.error("expired auth rows delete failed", { code: failureCode(err), ...deleted });
    throw err;
  }
  logger.info("expired auth rows deleted", { ...deleted });
  return deleted;
}

/**
 * Runs `deleteExpiredAuthRows` now and then every `AUTH_CLEANUP_INTERVAL_MS`
 * in this process, which has no other scheduler. Each replica runs it. The
 * timer does not keep the process alive. Returns a function that stops it.
 */
export function startAuthCleanup(options: AuthCleanupOptions): () => void {
  const run = (): void => {
    // A failed run has logged its line. The next run starts over.
    deleteExpiredAuthRows(options).catch(() => {});
  };
  run();
  const timer = setInterval(run, AUTH_CLEANUP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
