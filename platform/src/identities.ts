import type { Pool } from "pg";

/**
 * Google and Discord identities linked to users (`oauth_identities`, §11,
 * §13.1). An identity is the provider plus the provider's stable id for the
 * account. Accounts are never matched by email: this service does not ask
 * the providers for one.
 */

export type ProviderName = "google" | "discord";

/**
 * The `users.id` of the user an identity signs in, creating the user and the
 * identity on its first sign-in. Two first sign-ins of one identity at once
 * create one user: the loser's transaction is rolled back and it reads the
 * winner's row.
 */
export async function signInWithIdentity(pool: Pool, provider: ProviderName, providerUserId: string): Promise<string> {
  const existing = await identityOwner(pool, provider, providerUserId);
  if (existing !== null) return existing;

  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows: users } = await client.query<{ id: string }>("insert into users default values returning id");
    const userId = users[0]?.id;
    if (userId === undefined) throw new Error("insert into users returned no row");
    const { rows } = await client.query<{ user_id: string }>(
      `insert into oauth_identities (user_id, provider, provider_user_id) values ($1, $2, $3)
       on conflict (provider, provider_user_id) do nothing
       returning user_id`,
      [userId, provider, providerUserId],
    );
    if (rows[0] !== undefined) {
      await client.query("commit");
      return userId;
    }
    await client.query("rollback");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  const winner = await identityOwner(pool, provider, providerUserId);
  if (winner === null) throw new Error("identity vanished after a conflicting insert");
  return winner;
}

/**
 * Links an identity to the user of `users.id` `userId`, for a signed-in user
 * who connects it explicitly.
 *
 * - `linked`: the identity is now the user's.
 * - `already linked`: it was the user's before.
 * - `other user`: it belongs to another user and stays there. Accounts are
 *   never merged.
 */
export async function linkIdentity(
  pool: Pool,
  userId: string,
  provider: ProviderName,
  providerUserId: string,
): Promise<"linked" | "already linked" | "other user"> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into oauth_identities (user_id, provider, provider_user_id) values ($1, $2, $3)
     on conflict (provider, provider_user_id) do nothing
     returning id`,
    [userId, provider, providerUserId],
  );
  if (rows[0] !== undefined) return "linked";
  const owner = await identityOwner(pool, provider, providerUserId);
  return owner === userId ? "already linked" : "other user";
}

async function identityOwner(pool: Pool, provider: ProviderName, providerUserId: string): Promise<string | null> {
  const { rows } = await pool.query<{ user_id: string }>(
    "select user_id from oauth_identities where provider = $1 and provider_user_id = $2",
    [provider, providerUserId],
  );
  return rows[0]?.user_id ?? null;
}
