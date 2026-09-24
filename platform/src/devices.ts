import type { ClientMetadata, Configuration, KoaContextWithOIDC } from "oidc-provider";
import type { Pool } from "pg";

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
 * and the grant's tokens.
 *
 * Only the bridge's own client may use the device flow. A registered or CIMD
 * client that names the device code grant is refused (`oidc-registration.ts`),
 * and the bridge API is the bridge client's alone (`oidc-tokens.ts`). So no
 * agent can phish a user code and get an `ingest` token.
 */

/** The bridge's pre-registered public client (§8.1). It has no secret. */
export const BRIDGE_CLIENT_ID = "ogmcp-bridge";

export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * The bridge's client: a native app with no redirect URI, allowed the device
 * code grant and refresh tokens only.
 */
export const BRIDGE_CLIENT: ClientMetadata = {
  client_id: BRIDGE_CLIENT_ID,
  client_name: "Open Gamer MCP bridge",
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

/** Why the page could not go on, as `DeviceAnswer.error` and `?result=` name it. */
export type DeviceError = "no_code" | "not_found" | "expired" | "used" | "failed";

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

/** oidc-provider's errors that re-render its user code page, by class name. */
const PAGE_ERRORS: Readonly<Record<string, DeviceError | "denied">> = {
  NoCodeError: "no_code",
  NotFoundError: "not_found",
  ExpiredError: "expired",
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
 * The provider settings of the device flow. `createOidcProvider` spreads
 * them in.
 */
export function deviceFlowConfiguration(): {
  settings: Pick<Configuration, "clients" | "loadExistingGrant">;
  features: Pick<NonNullable<Configuration["features"]>, "deviceFlow">;
} {
  return {
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
