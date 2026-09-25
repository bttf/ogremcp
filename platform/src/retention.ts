import type { Pool } from "pg";

import { failureCode } from "./db.js";
import { logger } from "./log.js";

/**
 * Retention by tier (§11, §14): a free user keeps `freeRetentionDays` of
 * uploads and snapshots, and a paid user keeps them forever.
 * `startRetention` deletes a free user's expired rows at start and once a
 * day.
 *
 * - An upload's age is counted from `uploads.received_at`, when the server
 *   stored it. Its snapshot is deleted with it, whatever its `snapshot_at`.
 *   The server sets `received_at`, so a player's clock can neither keep a
 *   row nor expire it early, and an upload without a snapshot (a failed or
 *   rejected parse) has one too. An offline upload that arrives late is kept
 *   `freeRetentionDays` from its arrival.
 * - After a paid-to-free downgrade, the user keeps all their history until
 *   `downgradeGraceDays` have passed since `users.tier_changed_at`, which a
 *   trigger sets on every tier change (migration 0012). Then the free rule
 *   applies, and history older than `freeRetentionDays` is deleted (D9).
 * - Only uploads and snapshots (§11). A user's events, issues, and
 *   usage_daily rows stay. `events.snapshot_uuid` and `issues.snapshot_uuid`
 *   are not foreign keys, and outlive the snapshot (migration 0009). No
 *   device row changes, so the device limit's slots (`first_stored_at`,
 *   §8.3) stay where they are.
 * - Each batch is one statement that deletes up to `batchSize` uploads and
 *   their snapshots, so no batch holds its locks for long. The batches run
 *   one after another, on one pooled connection at a time, until a batch
 *   finds fewer rows than that.
 * - A batch locks the uploads it deletes `for update skip locked`, so two
 *   instances that run at once during a deploy take different rows, and
 *   neither waits nor fails. The re-parse command's upload is skipped the
 *   same way. It locks each user `for key share skip locked`: a user whose
 *   "Delete my data" or "Delete account" (`account.ts`) holds the user's row
 *   is skipped, and such a delete that starts during the batch waits for it.
 *   Without that lock the two could deadlock, since the delete takes
 *   snapshots before uploads. `for key share` blocks no ingest, no
 *   `report_issue`, and no tier change.
 * - Each run logs one line with the rows it deleted, by table, and no user
 *   identifier. A run that fails logs its code and the rows it deleted
 *   before the failure.
 */

export interface RetentionSettings {
  /** `FREE_RETENTION_DAYS`: how many days of uploads and snapshots a free user keeps. */
  freeRetentionDays: number;
  /** `DOWNGRADE_GRACE_DAYS`: how many days after a downgrade to free a user keeps all their history (D9). */
  downgradeGraceDays: number;
}

/** §11 and §19.1 D9. Both are proposed values. */
export const DEFAULT_RETENTION: RetentionSettings = { freeRetentionDays: 30, downgradeGraceDays: 30 };

/** How often `startRetention` runs. */
export const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The most uploads one batch deletes, with their snapshots. */
export const RETENTION_BATCH = 500;

/** The rows a run deleted, by table. */
export interface DeletedHistory {
  uploads: number;
  snapshots: number;
}

/**
 * One batch. `$1` is `freeRetentionDays`, `$2` `downgradeGraceDays`, and `$3`
 * the batch size. The snapshots are deleted by name, not by the cascade from
 * uploads, so that they are counted.
 */
const DELETE_BATCH = `
  with expired as (
    select up.id
      from uploads up
      join users u on u.id = up.user_id
     where u.tier = 'free'
       and (u.tier_changed_at is null or u.tier_changed_at <= now() - make_interval(days => $2))
       and up.received_at < now() - make_interval(days => $1)
     limit $3
       for update of up skip locked
       for key share of u skip locked
  ), deleted_snapshots as (
    delete from snapshots where upload_id in (select id from expired) returning 1
  ), deleted_uploads as (
    delete from uploads where id in (select id from expired) returning 1
  )
  select (select count(*) from deleted_uploads)::int as uploads,
         (select count(*) from deleted_snapshots)::int as snapshots`;

export interface RetentionOptions {
  pool: Pool;
  /** `FREE_RETENTION_DAYS` and `DOWNGRADE_GRACE_DAYS`. Default: `DEFAULT_RETENTION`. */
  settings?: RetentionSettings;
  /** Default: `RETENTION_BATCH`. */
  batchSize?: number;
}

/**
 * Deletes every free user's expired uploads and snapshots, in batches, and
 * logs one line. Throws on the first batch that fails, after its line; the
 * batches before it stay deleted.
 */
export async function deleteExpiredHistory({
  pool,
  settings = DEFAULT_RETENTION,
  batchSize = RETENTION_BATCH,
}: RetentionOptions): Promise<DeletedHistory> {
  const deleted: DeletedHistory = { uploads: 0, snapshots: 0 };
  try {
    for (;;) {
      const { rows } = await pool.query<DeletedHistory>(DELETE_BATCH, [settings.freeRetentionDays, settings.downgradeGraceDays, batchSize]);
      const batch = rows[0] ?? { uploads: 0, snapshots: 0 };
      deleted.uploads += batch.uploads;
      deleted.snapshots += batch.snapshots;
      if (batch.uploads < batchSize) break;
    }
  } catch (err) {
    logger.error("expired history delete failed", { code: failureCode(err), ...deleted });
    throw err;
  }
  logger.info("expired history deleted", { ...deleted });
  return deleted;
}

/**
 * Runs `deleteExpiredHistory` now and then every `RETENTION_INTERVAL_MS` in
 * this process, which has no other scheduler. Each replica runs it. The timer
 * does not keep the process alive. Returns a function that stops it.
 */
export function startRetention(options: RetentionOptions): () => void {
  const run = (): void => {
    // A failed run has logged its line. The next run starts over.
    deleteExpiredHistory(options).catch(() => {});
  };
  run();
  const timer = setInterval(run, RETENTION_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
