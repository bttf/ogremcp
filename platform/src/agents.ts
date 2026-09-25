import type Provider from "oidc-provider";
import type { Pool } from "pg";

import { withoutFetching } from "./cimd.js";
import { BRIDGE_CLIENT_ID } from "./devices.js";
import { clientIdHost } from "./oidc.js";

/**
 * Connected agents (§9, §13.2): a user's grants to agent clients, which the
 * Connected agents page lists and revokes through `api.ts`. An agent client
 * is any client but the bridge's (`BRIDGE_CLIENT_ID`), whether registered by
 * DCR, CIMD, or statically. The bridge's grants are devices (`devices.ts`).
 *
 * A grant is oidc-provider's `Grant` row in `oidc_models`, and it is live
 * while that row exists and has not expired. The page names a grant by the
 * row's uuid (§11), not by oidc-provider's grant id.
 */

/** One of a user's live agent grants, as the Connected agents page lists it (§13.2). */
export interface AgentGrant {
  /** The grant's `oidc_models.uuid`. */
  id: string;
  client_id: string;
  /**
   * The client's `client_name`, or null when it names none or is not known
   * without a fetch: a CIMD client whose document is not cached.
   */
  client_name: string | null;
  /** For a CIMD client, the host of its `client_id` URL, which published the name. Null for another client. */
  client_host: string | null;
  /** When the user approved the agent, ISO 8601. */
  approved_at: string | null;
  /**
   * When the token endpoint last issued the grant an access token, ISO 8601,
   * or null. The agent uses each token for up to its lifetime
   * (`OAUTH_ACCESS_TOKEN_LIFETIME_MINUTES`), so it may have been used since.
   */
  last_used_at: string | null;
}

interface GrantRow {
  id: string;
  client_id: string;
  approved_at: Date | null;
  last_used_at: Date | null;
}

/**
 * The client's name, or null. Nothing is fetched (`withoutFetching`): a
 * CIMD client's name comes from oidc-provider's cache of its document, or is
 * null. Reloading the page then cannot spend the CIMD fetch limits that
 * sign-ins need.
 */
async function clientName(provider: Provider, clientId: string): Promise<string | null> {
  try {
    const name = (await withoutFetching(() => provider.Client.find(clientId)))?.clientName;
    return typeof name === "string" && name !== "" ? name : null;
  } catch {
    return null;
  }
}

/** The live agent grants of the user of `users.uuid` `userUuid`, the newest first. */
export async function listAgentGrants(pool: Pool, provider: Provider, userUuid: string): Promise<AgentGrant[]> {
  const { rows } = await pool.query<GrantRow>(
    `select g.uuid as id,
            g.payload->>'clientId' as client_id,
            to_timestamp((g.payload->>'iat')::double precision) as approved_at,
            (select to_timestamp(max((t.payload->>'iat')::double precision))
               from oidc_models t
              where t.model = 'AccessToken' and t.grant_id = g.oidc_id) as last_used_at
       from oidc_models g
      where g.model = 'Grant'
        and g.payload->>'accountId' = $1
        and g.payload->>'clientId' <> $2
        and (g.expires_at is null or g.expires_at > now())
      order by g.id desc`,
    [userUuid, BRIDGE_CLIENT_ID],
  );
  const names = new Map<string, Promise<string | null>>();
  for (const row of rows) if (!names.has(row.client_id)) names.set(row.client_id, clientName(provider, row.client_id));
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      client_id: row.client_id,
      client_name: await (names.get(row.client_id) ?? null),
      client_host: clientIdHost(row.client_id),
      approved_at: row.approved_at?.toISOString() ?? null,
      last_used_at: row.last_used_at?.toISOString() ?? null,
    })),
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Revokes the agent grant `id` of the user of `users.uuid` `userUuid`: deletes
 * the grant with every token and code of it, in one statement. Access tokens
 * are looked up at each request (`requireToken`), so they are refused from
 * then on, and the refresh token fails. Answers false, and changes nothing,
 * when the user has no such agent grant.
 */
export async function revokeAgentGrant(pool: Pool, userUuid: string, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const { rows } = await pool.query<{ count: number }>(
    `with revoked as (
       delete from oidc_models
        where model = 'Grant' and uuid = $1 and payload->>'accountId' = $2 and payload->>'clientId' <> $3
       returning oidc_id
     ), owned as (
       delete from oidc_models where grant_id in (select oidc_id from revoked)
     )
     select count(*)::int as count from revoked`,
    [id, userUuid, BRIDGE_CLIENT_ID],
  );
  return (rows[0]?.count ?? 0) > 0;
}
