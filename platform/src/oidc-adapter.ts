import { type Adapter, type AdapterPayload, errors } from "oidc-provider";
import type { Pool } from "pg";

/**
 * The oidc-provider storage adapter (§9, §11, §13.1): every model
 * oidc-provider persists, in the one table `oidc_models` (migration 0003).
 * oidc-provider makes one adapter per model name.
 *
 * A row past its expiry is never returned. oidc-provider checks each
 * payload's own expiry as well.
 *
 * Postgres stores no NUL character, in text or in jsonb, and a query that
 * holds one fails. Every value here can come from a request, such as a
 * `client_id` or a `state`, so a lookup of a value with a NUL finds nothing
 * and a write of one is refused as `invalid_request`, not a server error.
 */
export class PostgresAdapter implements Adapter {
  constructor(
    private readonly pool: Pool,
    /** oidc-provider's model name, e.g. `AccessToken`. */
    readonly model: string,
  ) {}

  /**
   * Stores the payload under `id`, replacing any earlier one. `expiresIn` is
   * in seconds; without it the row does not expire, as for a client. A
   * replaced row keeps its `last_used_at` (migrations 0004 and 0014).
   */
  async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
    let nul = id.includes("\0");
    const json = JSON.stringify(payload, (key, value: unknown) => {
      if (key.includes("\0") || (typeof value === "string" && value.includes("\0"))) nul = true;
      return value;
    });
    if (nul) throw new errors.InvalidRequest("a parameter holds a NUL character");
    await this.pool.query(
      `insert into oidc_models (model, oidc_id, payload, grant_id, user_code, uid, expires_at)
       values ($1, $2, $3::jsonb, $4, $5, $6, now() + make_interval(secs => $7::double precision))
       on conflict (model, oidc_id) do update
         set payload = excluded.payload,
             grant_id = excluded.grant_id,
             user_code = excluded.user_code,
             uid = excluded.uid,
             expires_at = excluded.expires_at`,
      [
        this.model,
        id,
        json,
        payload.grantId ?? null,
        payload.userCode ?? null,
        payload.uid ?? null,
        typeof expiresIn === "number" ? expiresIn : null,
      ],
    );
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    return this.findBy("oidc_id", id);
  }

  /** A device code by its user code (§8.1). */
  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    return this.findBy("user_code", userCode);
  }

  /** A session by its uid. */
  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    return this.findBy("uid", uid);
  }

  /** Marks a code or token as used: `payload.consumed` becomes the time, in seconds since the epoch. */
  async consume(id: string): Promise<void> {
    if (id.includes("\0")) return;
    await this.pool.query(
      `update oidc_models
          set payload = jsonb_set(payload, '{consumed}', to_jsonb(floor(extract(epoch from now()))::bigint))
        where model = $1 and oidc_id = $2`,
      [this.model, id],
    );
  }

  async destroy(id: string): Promise<void> {
    if (id.includes("\0")) return;
    await this.pool.query("delete from oidc_models where model = $1 and oidc_id = $2", [this.model, id]);
  }

  /** Deletes this model's rows of a grant. oidc-provider calls it on each token and code model in turn. */
  async revokeByGrantId(grantId: string): Promise<void> {
    if (grantId.includes("\0")) return;
    await this.pool.query("delete from oidc_models where model = $1 and grant_id = $2", [this.model, grantId]);
  }

  /** The newest live row whose `column` is `value`. */
  private async findBy(column: "oidc_id" | "user_code" | "uid", value: string): Promise<AdapterPayload | undefined> {
    if (value.includes("\0")) return undefined;
    const { rows } = await this.pool.query<{ payload: AdapterPayload }>(
      `select payload from oidc_models
        where model = $1 and ${column} = $2 and (expires_at is null or expires_at > now())
        order by id desc
        limit 1`,
      [this.model, value],
    );
    return rows[0]?.payload;
  }
}

/** The `adapter` setting of the provider: one adapter per model name, sharing the pool. */
export function postgresAdapter(pool: Pool): (model: string) => PostgresAdapter {
  return (model) => new PostgresAdapter(pool, model);
}
