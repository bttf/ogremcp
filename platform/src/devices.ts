import type { Response } from "express";
import type Provider from "oidc-provider";
import type { ClientMetadata, Configuration, KoaContextWithOIDC } from "oidc-provider";
import type { Pool } from "pg";

import { type Bucket, level, type Limit, limit, waitSeconds } from "./token-bucket.js";
import { currentUser } from "./web-sessions.js";

/**
 * Bridges as devices (§8.1, §11): the OAuth device authorization grant
 * (RFC 8628) through oidc-provider, and the `devices` rows it creates.
 *
 * 1. The bridge posts to `/oauth/device/auth` as `BRIDGE_CLIENT_ID` with
 *    scope `ingest`, and shows the user code and `/device`.
 * 2. The web UI's Device approval page, `/device`, lets a signed-in user
 *    enter the code, see what asks for access, and approve or deny it. The
 *    page talks to oidc-provider's `code_verification` route at `/device`:
 *    the hooks below answer it in JSON, not HTML (`DeviceAnswer`).
 * 3. Approval goes through oidc-provider's interaction. The login prompt is
 *    the web session (`oidc.ts`). At the consent prompt `oidc.ts` saves a new
 *    grant and creates its `devices` row with `createDevice`, since the
 *    user's click on `/device` was the approval. The browser then lands on
 *    `/device?result=approved`.
 * 4. The bridge polls `/oauth/token` with its device code and gets an access
 *    token for the bridge API with scope `ingest`, and a refresh token
 *    (`oidc-tokens.ts`).
 *
 * Every approval gets a grant of its own, so each device can be revoked
 * alone (`loadExistingGrant`). `revokeDevice` revokes a device, its grant,
 * and the grant's tokens. The Devices page (§13.2) lists, renames, and
 * revokes a user's devices through `api.ts`.
 *
 * A user code that matches no live device code is a miss. Misses are limited
 * per user and for all users together (`MissLimiter`), so no account can
 * guess its way to another user's bridge.
 *
 * Only the bridge's own client may use the device flow. A registered or CIMD
 * client that names the device code grant is refused (`oidc-registration.ts`),
 * and the bridge API is the bridge client's alone (`oidc-tokens.ts`). So no
 * agent can phish a user code and get an `ingest` token.
 */

/** The bridge's pre-registered public client (§8.1). It has no secret. */
export const BRIDGE_CLIENT_ID = "ogremcp-bridge";

export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * The bridge's client: a native app with no redirect URI, allowed the device
 * code grant and refresh tokens only.
 */
export const BRIDGE_CLIENT: ClientMetadata = {
  client_id: BRIDGE_CLIENT_ID,
  client_name: "Ogre MCP bridge",
  application_type: "native",
  token_endpoint_auth_method: "none",
  grant_types: [DEVICE_CODE_GRANT, "refresh_token"],
  response_types: [],
  redirect_uris: [],
};

/** The device flow's page (§13.2): oidc-provider's `code_verification` route, and the web UI's page. */
export const DEVICE_PAGE_PATH = "/device";

/** oidc-provider's routes of the page and its return after an interaction. */
const DEVICE_PAGE_ROUTES = new Set(["code_verification", "device_resume"]);

/** oidc-provider's router matches a path whatever its ASCII case, and with one trailing slash. */
const DEVICE_PAGE_PATTERN = /^\/device\/?$/i;

/** Why the page could not go on, as `DeviceAnswer.error` and `?result=` name it. */
export type DeviceError = "no_code" | "not_found" | "expired" | "used" | "rate_limited" | "failed";

/** The limits on misses (*proposed*, §0). `config.ts` reads them from the environment. */
export interface MissSettings {
  /** `DEVICE_CODE_MISS_RATE_PER_HOUR`: misses one user may make per hour once the burst is spent. */
  ratePerHour: number;
  /** `DEVICE_CODE_MISS_BURST`: misses one user may make at once. */
  burst: number;
  /** `DEVICE_CODE_MISS_GLOBAL_RATE_PER_HOUR`: misses of every user together, per hour. */
  globalRatePerHour: number;
  /** `DEVICE_CODE_MISS_GLOBAL_BURST`: misses of every user together, at once. */
  globalBurst: number;
}

/** A user mistypes a code a few times. Ten guesses an hour among 20^8 codes find nothing. */
export const DEFAULT_MISSES: MissSettings = { ratePerHour: 10, burst: 10, globalRatePerHour: 1000, globalBurst: 100 };

/** Most users `MissLimiter` keeps a bucket for. */
export const MAX_TRACKED_USERS = 10_000;

/**
 * The limit on misses: token buckets as in `RegistrationLimiter`, one per
 * user (by `users.id`) and one for all users. Each post to `/device` takes a
 * miss from both before it looks its code up, or is refused while either is
 * empty; a post that did not miss gives it back (`refund`). So concurrent
 * posts cannot pass the limit together.
 *
 * At most `MAX_TRACKED_USERS` user buckets are kept; past that, the least
 * recently used one is dropped. The buckets are in memory, per process.
 */
export class MissLimiter {
  readonly #user: Limit;
  readonly #global: Limit;
  /** In order of last use, least recent first. */
  readonly #users = new Map<string, Bucket>();
  #globalBucket: Bucket | undefined;

  constructor(
    settings: MissSettings,
    private readonly now: () => number = Date.now,
  ) {
    this.#user = limit(settings.burst, settings.ratePerHour);
    this.#global = limit(settings.globalBurst, settings.globalRatePerHour);
  }

  /** Takes a miss from `userId`: 0 when it is allowed, or else the seconds until one will be. */
  take(userId: string): number {
    const now = this.now();
    const own = level(this.#user, this.#users.get(userId), now);
    const all = level(this.#global, this.#globalBucket, now);
    const wait = Math.max(waitSeconds(this.#user, own), waitSeconds(this.#global, all));
    if (wait > 0) return wait;
    this.#keep(userId, { tokens: own - 1, at: now });
    this.#globalBucket = { tokens: all - 1, at: now };
    return 0;
  }

  /** Gives back the miss a post took, when it did not miss. */
  refund(userId: string): void {
    const now = this.now();
    this.#keep(userId, { tokens: Math.min(this.#user.burst, level(this.#user, this.#users.get(userId), now) + 1), at: now });
    this.#globalBucket = { tokens: Math.min(this.#global.burst, level(this.#global, this.#globalBucket, now) + 1), at: now };
  }

  #keep(userId: string, bucket: Bucket): void {
    this.#users.delete(userId);
    if (this.#users.size >= MAX_TRACKED_USERS) {
      const oldest = this.#users.keys().next();
      if (oldest.done !== true) this.#users.delete(oldest.value);
    }
    this.#users.set(userId, bucket);
  }
}

/** Set on `ctx.state` when a post's user code missed. */
const MISSED = "ogremcpUserCodeMissed";

/**
 * What oidc-provider's `/device` answers the web UI's page, in JSON:
 *
 * - `enter`: to `GET /device`, the `xsrf` the page's posts must carry, and
 *   with `error` to a post that failed. `xsrf` is then a new one.
 * - `confirm`: to `POST /device` with `xsrf` and `user_code`, the code in the
 *   form the bridge shows and the name of the client that asks. Nothing is
 *   approved yet.
 *
 * The page approves or denies with a form post (a navigation) of `xsrf`,
 * `user_code`, and `confirm=yes` or `abort=yes`, which goes through the
 * interaction and ends at `/device?result=` `approved`, `denied`, or a
 * `DeviceError`.
 */
export type DeviceAnswer =
  | { step: "enter"; xsrf: string; error?: DeviceError }
  | { step: "confirm"; xsrf: string; user_code: string; client_name: string };

/** oidc-provider's errors that re-render its user code page, by class name. The first two are misses. */
const PAGE_ERRORS: Readonly<Record<string, DeviceError | "denied">> = {
  NotFoundError: "not_found",
  ExpiredError: "expired",
  NoCodeError: "no_code",
  AlreadyUsedError: "used",
  AbortedError: "denied",
};

function xsrfOf(ctx: KoaContextWithOIDC): string {
  return String((ctx.oidc.session?.state as { secret?: unknown } | undefined)?.secret ?? "");
}

function answer(ctx: KoaContextWithOIDC, body: DeviceAnswer): void {
  ctx.type = "json";
  ctx.body = body;
}

/** Sends a form post's navigation back to the page, which shows `result`. */
function finish(ctx: KoaContextWithOIDC, result: DeviceError | "approved" | "denied"): void {
  ctx.redirect(`${DEVICE_PAGE_PATH}?result=${result}`);
  ctx.status = 303;
}

/** A page load or form post, not the page's own `fetch`. */
function isNavigation(ctx: KoaContextWithOIDC): boolean {
  return ctx.accepts("json", "html") === "html";
}

/**
 * The provider settings of the device flow, which `createOidcProvider`
 * spreads in, and the Koa middleware it gives `provider.use`. The middleware
 * limits misses: a post to `/device` over the limit gets 429 and
 * `{ error: "rate_limited" }`, or as a form post goes back to the page with
 * `?result=rate_limited`.
 */
export function deviceFlowConfiguration(misses: MissSettings): {
  settings: Pick<Configuration, "clients" | "loadExistingGrant">;
  features: Pick<NonNullable<Configuration["features"]>, "deviceFlow">;
  middleware: Parameters<Provider["use"]>[0];
} {
  const limiter = new MissLimiter(misses);
  return {
    middleware: async (ctx, next) => {
      // mountOidc passes no post to /device without a web session.
      const user = ctx.method === "POST" && DEVICE_PAGE_PATTERN.test(ctx.path) ? currentUser(ctx.res as unknown as Response) : null;
      if (user === null) return next();
      const wait = limiter.take(user.id);
      if (wait > 0) {
        ctx.set("Cache-Control", "no-store");
        if (isNavigation(ctx as KoaContextWithOIDC)) return finish(ctx as KoaContextWithOIDC, "rate_limited");
        ctx.status = 429;
        ctx.set("Retry-After", String(wait));
        ctx.body = { error: "rate_limited" };
        return;
      }
      try {
        await next();
      } finally {
        if (ctx.state[MISSED] !== true) limiter.refund(user.id);
      }
    },
    settings: {
      clients: [BRIDGE_CLIENT],
      // oidc-provider's default reuses the grant its browser session holds
      // for the client, which would give every bridge a browser approves one
      // grant. On the device page's routes only the grant the consent prompt
      // just saved counts.
      loadExistingGrant: async ({ oidc }) => {
        let grantId = oidc.result?.consent?.grantId;
        if (grantId === undefined && !DEVICE_PAGE_ROUTES.has(oidc.route) && oidc.client !== undefined) {
          grantId = oidc.session?.grantIdFor(oidc.client.clientId);
        }
        return grantId === undefined ? undefined : oidc.provider.Grant.find(grantId);
      },
    },
    features: {
      deviceFlow: {
        enabled: true,
        // oidc-provider's defaults, which the web UI's page checks a code
        // against (`web/src/user-code.ts`): eight of the RFC 8628
        // consonants, shown as BCDF-GHJK.
        charset: "base-20",
        mask: "****-****",
        // oidc-provider keeps the bridge's address and user agent by default.
        // No page shows them, so none is kept.
        deviceInfo: () => ({}),
        userCodeInputSource: (ctx, _form, _out, err) => {
          if (err === undefined) return answer(ctx, { step: "enter", xsrf: xsrfOf(ctx) });
          const error = PAGE_ERRORS[err.name] ?? "failed";
          if (error === "not_found" || error === "expired") ctx.state[MISSED] = true;
          if (isNavigation(ctx)) return finish(ctx, error);
          // A deny is a form post, so a fetch gets no `denied`.
          answer(ctx, { step: "enter", xsrf: xsrfOf(ctx), error: error === "denied" ? "failed" : error });
        },
        userCodeConfirmSource: (ctx, _form, client, _deviceInfo, userCode) => {
          const clientName = client.clientName ?? client.clientId;
          answer(ctx, { step: "confirm", xsrf: xsrfOf(ctx), user_code: userCode, client_name: clientName });
        },
        successSource: (ctx) => finish(ctx, "approved"),
      },
    },
  };
}

/**
 * Creates the `devices` row of a bridge the user of `users.id` `userId` has
 * approved, for its grant. OS and versions stay null until its first upload.
 * Answers the device's uuid.
 */
export async function createDevice(pool: Pool, userId: string, grantId: string): Promise<string> {
  const { rows } = await pool.query<{ uuid: string }>("insert into devices (user_id, grant_id) values ($1, $2) returning uuid", [userId, grantId]);
  const uuid = rows[0]?.uuid;
  if (uuid === undefined) throw new Error("insert into devices returned no row");
  return uuid;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Revokes the device `deviceUuid` of the user of `users.id` `userId` (§8.1):
 * sets its `revoked_at`, and deletes its grant with every token and code of
 * the grant, in one transaction. From then its access tokens are refused and
 * its refresh token fails. The row stays, so its uploads keep their device.
 *
 * Answers false, and changes nothing, when the user has no such device or it
 * is already revoked.
 */
export async function revokeDevice(pool: Pool, userId: string, deviceUuid: string): Promise<boolean> {
  if (!UUID.test(deviceUuid)) return false;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ grant_id: string | null }>(
      "update devices set revoked_at = now() where uuid = $1 and user_id = $2 and revoked_at is null returning grant_id",
      [deviceUuid, userId],
    );
    const row = rows[0];
    if (row === undefined) {
      await client.query("rollback");
      return false;
    }
    if (row.grant_id !== null) {
      // The grant's own row, and every row oidc-provider stored with its grantId.
      await client.query("delete from oidc_models where (model = 'Grant' and oidc_id = $1) or grant_id = $1", [row.grant_id]);
    }
    await client.query("commit");
    return true;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The longest name, in characters, a user may give a device on the Devices page (§13.2). */
export const DEVICE_NAME_MAX_LENGTH = 64;

/** One of a user's devices, as the Devices page lists it (§13.2). */
export interface DeviceInfo {
  /** `devices.uuid`. */
  uuid: string;
  /** The name the user gave it, or null: the page shows one made from `os` and `approved_at`. */
  name: string | null;
  /** `client.os` of its latest upload (§8.3). Null until its first upload. */
  os: string | null;
  /** `client.bridge_version` of its latest upload. Null until its first upload. */
  bridge_version: string | null;
  /** When the user approved it at `/device`, ISO 8601. */
  approved_at: string;
  /** When it last reached ingest, ISO 8601, or null. */
  last_seen_at: string | null;
  /**
   * Whether it no longer holds a live grant: the user revoked it, or its
   * grant is gone. A bridge that revokes its own refresh token revokes the
   * grant (`oidc-tokens.ts`), and a grant expires `OAUTH_GRANT_LIFETIME_DAYS`
   * after approval. Neither sets `revoked_at`, so the grant is looked up here.
   * A revoked device's tokens are refused.
   */
  revoked: boolean;
}

/**
 * A condition that holds while the device `alias` (a `devices` row) is live:
 * not revoked, and its grant's row exists and has not expired, as
 * `PostgresAdapter.find` reads it (`DeviceInfo.revoked`). The Devices page and
 * the ingest device limit (§8.3) share it.
 */
export function liveDeviceSql(alias: string): string {
  return `(${alias}.revoked_at is null and exists (
    select 1 from oidc_models g
     where g.model = 'Grant' and g.oidc_id = ${alias}.grant_id and (g.expires_at is null or g.expires_at > now())
  ))`;
}

/** A device's columns as `DeviceInfo` has them, for `devices d`. */
const DEVICE_INFO = `d.uuid, d.name, d.os, d.bridge_version, d.created_at as approved_at, d.last_seen_at,
  not ${liveDeviceSql("d")} as revoked`;

interface DeviceRow {
  uuid: string;
  name: string | null;
  os: string | null;
  bridge_version: string | null;
  approved_at: Date;
  last_seen_at: Date | null;
  revoked: boolean;
}

function deviceInfo(row: DeviceRow): DeviceInfo {
  return { ...row, approved_at: row.approved_at.toISOString(), last_seen_at: row.last_seen_at?.toISOString() ?? null };
}

/** The devices of the user of `users.id` `userId`: the live ones, then the revoked ones, each the newest approval first. */
export async function listDevices(pool: Pool, userId: string): Promise<DeviceInfo[]> {
  const { rows } = await pool.query<DeviceRow>(`select ${DEVICE_INFO} from devices d where d.user_id = $1 order by revoked, d.id desc`, [userId]);
  return rows.map(deviceInfo);
}

/** The device `deviceUuid` of the user of `users.id` `userId`, or null when the user has no such device. */
export async function findDevice(pool: Pool, userId: string, deviceUuid: string): Promise<DeviceInfo | null> {
  if (!UUID.test(deviceUuid)) return null;
  const { rows } = await pool.query<DeviceRow>(`select ${DEVICE_INFO} from devices d where d.uuid = $1 and d.user_id = $2`, [deviceUuid, userId]);
  return rows[0] === undefined ? null : deviceInfo(rows[0]);
}

/**
 * A device name as the user typed it, trimmed. An empty name, or null, is
 * null: the device goes back to the page's fallback name. Undefined for a
 * value that is not a string or null, is longer than
 * `DEVICE_NAME_MAX_LENGTH` characters, or holds a control character.
 */
export function deviceName(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (name === "") return null;
  if ([...name].length > DEVICE_NAME_MAX_LENGTH || /\p{Cc}/u.test(name)) return undefined;
  return name;
}

/**
 * Sets the name of the device `deviceUuid` of the user of `users.id`
 * `userId`, a revoked one too, to a name from `deviceName`. Answers the
 * device, or null, and changes nothing, when the user has no such device.
 */
export async function renameDevice(pool: Pool, userId: string, deviceUuid: string, name: string | null): Promise<DeviceInfo | null> {
  if (!UUID.test(deviceUuid)) return null;
  const { rows } = await pool.query<DeviceRow>(
    `update devices d set name = $3 where d.uuid = $1 and d.user_id = $2 returning ${DEVICE_INFO}`,
    [deviceUuid, userId, name],
  );
  return rows[0] === undefined ? null : deviceInfo(rows[0]);
}
