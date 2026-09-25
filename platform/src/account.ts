import type { Pool, PoolClient } from "pg";

import { failureCode } from "./db.js";
import { logger } from "./log.js";

/**
 * "Delete my data" and "Delete account" (§11, §13.2), which the Account page
 * calls through `api.ts`. Both hard-delete, in one transaction each, and log
 * one line with the user's uuid and the rows deleted from each table.
 *
 * - `deleteUserData` deletes the user's uploads, snapshots, events (tool
 *   calls and ingest requests), and issues (`report_issue`). The account,
 *   its sign-in identities, devices, enabled games, and agent grants stay,
 *   so the user can go on using the service.
 *   `usage_daily` (§14) stays too: §11 does not list it, and deleting it
 *   would reset the day's tool-call cap.
 * - `deleteAccount` deletes the same, then the user's rows of oidc-provider
 *   (`oidc_models`): the grants of every bridge and agent, every token and
 *   code of them, and the user's OAuth sessions and interactions. Then the
 *   user's web sessions, identities, enabled games, devices, and the user.
 *   `usage_daily` goes with the user's row, by its cascade. Access tokens
 *   are looked up at each request (`requireToken`), so every bridge and
 *   agent token is refused from the commit on.
 *
 * The deletes run in foreign key order. `uploads.device_id` has no cascade
 * (migration 0002), so uploads go before devices, and snapshots go before
 * uploads so that they are counted.
 *
 * The transaction first locks the user's row. An insert that references the
 * user then waits for the commit, so nothing the user writes meanwhile
 * escapes the delete; after "Delete account" such an insert fails. "Delete
 * account" locks the user's devices before the user, the order ingest takes
 * them in (`ingest.ts` locks the device, then its insert reads the user), so
 * an upload in flight waits instead of deadlocking. `no key update` on the
 * devices leaves an events insert that reads a device unblocked. The
 * re-parse command (`reparse-uploads.ts`) locks an upload, then its snapshot
 * insert reads the user, so it can still deadlock with a delete. A delete
 * that Postgres aborts for a deadlock or a serialization failure is run once
 * more in a new transaction.
 */

/** The rows "Delete my data" deleted, by table. */
export interface DeletedData {
  issues: number;
  events: number;
  snapshots: number;
  uploads: number;
}

/** The rows "Delete account" deleted, by table. `oidc_models` counts the user's rows of oidc-provider. */
export interface DeletedAccount extends DeletedData {
  oidc_models: number;
  web_sessions: number;
  oauth_identities: number;
  user_games: number;
  devices: number;
  users: number;
}

/** The user whose rows are deleted: `users.id` and `users.uuid`. */
export interface AccountUser {
  id: string;
  uuid: string;
}

/**
 * The user's rows of oidc-provider: every row whose payload names the user's
 * uuid as its account (grants, tokens, codes, sessions), every row of one of
 * the user's grants, and interactions whose session or login names the user.
 */
const DELETE_OIDC_ROWS = `
  delete from oidc_models
   where payload->>'accountId' = $1
      or grant_id in (select oidc_id from oidc_models where model = 'Grant' and payload->>'accountId' = $1)
      or (model = 'Interaction' and (payload->'session'->>'accountId' = $1 or payload->'result'->'login'->>'accountId' = $1))`;

async function deleted(client: PoolClient, sql: string, params: unknown[]): Promise<number> {
  return (await client.query(sql, params)).rowCount ?? 0;
}

/** Locks the user's row. False when the user no longer exists. */
async function lockUser(client: PoolClient, userId: string): Promise<boolean> {
  return ((await client.query("select 1 from users where id = $1 for update", [userId])).rowCount ?? 0) > 0;
}

const NO_DATA: DeletedData = { issues: 0, events: 0, snapshots: 0, uploads: 0 };

async function deleteData(client: PoolClient, userId: string): Promise<DeletedData> {
  const issues = await deleted(client, "delete from issues where user_id = $1", [userId]);
  const events = await deleted(client, "delete from events where user_id = $1", [userId]);
  const snapshots = await deleted(client, "delete from snapshots where user_id = $1", [userId]);
  const uploads = await deleted(client, "delete from uploads where user_id = $1", [userId]);
  return { issues, events, snapshots, uploads };
}

/** Postgres's `deadlock_detected` and `serialization_failure`: the transaction was aborted, and a new one may pass. */
const RETRYABLE = new Set(["40P01", "40001"]);

/** Runs `work` in a transaction, and once more in a new one when Postgres aborts the first with a `RETRYABLE` error. */
async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  try {
    return await transaction(pool, work);
  } catch (err) {
    if (!RETRYABLE.has(failureCode(err))) throw err;
    return transaction(pool, work);
  }
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** "Delete my data" for `user` (§11). Answers the rows deleted; all zero when the user no longer exists. */
export async function deleteUserData(pool: Pool, user: AccountUser): Promise<DeletedData> {
  const counts = await inTransaction(pool, async (client) =>
    (await lockUser(client, user.id)) ? deleteData(client, user.id) : NO_DATA,
  );
  logger.info("user data deleted", { user_uuid: user.uuid, ...counts });
  return counts;
}

/** "Delete account" for `user` (§11). Answers the rows deleted; all zero when the user no longer exists. */
export async function deleteAccount(pool: Pool, user: AccountUser): Promise<DeletedAccount> {
  const counts = await inTransaction(pool, async (client): Promise<DeletedAccount> => {
    await client.query("select 1 from devices where user_id = $1 order by id for no key update", [user.id]);
    if (!(await lockUser(client, user.id))) {
      return { ...NO_DATA, oidc_models: 0, web_sessions: 0, oauth_identities: 0, user_games: 0, devices: 0, users: 0 };
    }
    const data = await deleteData(client, user.id);
    const oidcModels = await deleted(client, DELETE_OIDC_ROWS, [user.uuid]);
    const webSessions = await deleted(client, "delete from web_sessions where user_id = $1", [user.id]);
    const identities = await deleted(client, "delete from oauth_identities where user_id = $1", [user.id]);
    const userGames = await deleted(client, "delete from user_games where user_id = $1", [user.id]);
    const devices = await deleted(client, "delete from devices where user_id = $1", [user.id]);
    const users = await deleted(client, "delete from users where id = $1", [user.id]);
    return {
      ...data,
      oidc_models: oidcModels,
      web_sessions: webSessions,
      oauth_identities: identities,
      user_games: userGames,
      devices,
      users,
    };
  });
  logger.info("account deleted", { user_uuid: user.uuid, ...counts });
  return counts;
}
