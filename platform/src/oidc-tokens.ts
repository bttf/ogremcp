import type { RequestHandler, Response } from "express";
import type Provider from "oidc-provider";
import { type Configuration, errors, type KoaContextWithOIDC } from "oidc-provider";

/**
 * The scopes, audiences, and token lifetimes of the OAuth server (§8.1, §9),
 * and `requireToken`, which checks an access token on a route of the MCP
 * server or the bridge API.
 *
 * There are two resources (RFC 8707), each with one scope:
 *
 * - The MCP server, `<PUBLIC_BASE_URL>/mcp`, with scope `read`, for agents.
 *   `read` covers every v1 MCP tool, `report_issue` included (§9, §10.3).
 * - The bridge API, `<PUBLIC_BASE_URL>/api/v1`, with scope `ingest`, for
 *   bridges (§8.1). A bridge calls all four endpoints of §8.2 with one token,
 *   so the identifier is their common base, not the ingest path alone. The web
 *   UI's JSON API is under the same path; it takes no access token.
 *
 * An access token has one of the two as its audience and carries only that
 * resource's scope. So an `ingest` token is refused at `/mcp`, and a `read`
 * token at the bridge API.
 *
 * Agents sign in with the authorization code flow (§9), and bridges with the
 * device flow (§8.1). Each flow can ask only for its own resource and scope,
 * so every agent client, whether registered by DCR, CIMD, or statically, can
 * be granted only `read` (with `openid` and `offline_access`), and only a
 * bridge `ingest`. An authorization request for the bridge API fails with
 * `invalid_target`, and one for `ingest` with `invalid_scope`, before it
 * reaches the consent page; a device request for the MCP server or `read`
 * fails the same way. A request without a `resource` gets its flow's
 * resource. At the token endpoint the grant already names the resource, and
 * a token request without `resource` gets the granted one.
 *
 * Access tokens are opaque and stored in `oidc_models`. `requireToken` looks
 * each one up, so revoking a grant ends its access tokens at once, not when
 * they expire (§8.1, §8.3). The platform is the only resource server, so no
 * other service has to read a token.
 *
 * Every client allowed the `refresh_token` grant gets a refresh token, with or
 * without `offline_access`. Each use replaces the refresh token with a new one
 * of full lifetime, and using a replaced one revokes the grant. Tokens outlive
 * the OAuth server's browser session: they end when they expire, when their
 * grant expires, or when the grant is revoked. Revoking a refresh token at
 * `/oauth/revoke` revokes its grant, with every token of it.
 */

export type Scope = "read" | "ingest";

export interface Resources {
  /** The MCP server (§9). Its access tokens carry scope `read`. */
  mcp: string;
  /** The bridge API (§8.2). Its access tokens carry scope `ingest`. */
  bridge: string;
}

/** The resource identifiers of the issuer, `PUBLIC_BASE_URL`. */
export function resourcesOf(issuer: string): Resources {
  return { mcp: `${issuer}/mcp`, bridge: `${issuer}/api/v1` };
}

/** Token lifetimes, in seconds (*proposed*, §0). `config.ts` reads them from the environment. */
export interface TokenLifetimes {
  /** `OAUTH_ACCESS_TOKEN_LIFETIME_MINUTES`. */
  accessTokenSeconds: number;
  /** `OAUTH_REFRESH_TOKEN_LIFETIME_DAYS`: counted from the refresh token's issue. Each use issues a new one. */
  refreshTokenSeconds: number;
  /**
   * `OAUTH_GRANT_LIFETIME_DAYS`: counted from the user's approval. The grant's
   * refresh tokens end with it, however recently they were replaced, so it is
   * the most a bridge or agent stays signed in without a new approval.
   */
  grantSeconds: number;
}

const DAY_SECONDS = 24 * 60 * 60;

export const DEFAULT_TOKEN_LIFETIMES: TokenLifetimes = {
  accessTokenSeconds: 60 * 60,
  refreshTokenSeconds: 30 * DAY_SECONDS,
  grantSeconds: 365 * DAY_SECONDS,
};

/** The routes of the device flow. RED-307 turns the flow on. */
const DEVICE_ROUTES = new Set(["device_authorization", "code_verification", "device_resume"]);

/**
 * The one resource a request may ask for, by the flow it belongs to.
 * Undefined at the token endpoint, where the grant bounds it.
 */
function flowResource(ctx: KoaContextWithOIDC, resources: Resources): string | undefined {
  if (ctx.oidc.route === "token") return undefined;
  return DEVICE_ROUTES.has(ctx.oidc.route) ? resources.bridge : resources.mcp;
}

/** The provider settings for scopes, resources, token lifetimes, and revocation. `createOidcProvider` spreads them in. */
export function tokenConfiguration(
  issuer: string,
  lifetimes: TokenLifetimes,
): {
  settings: Pick<Configuration, "scopes" | "ttl" | "issueRefreshToken" | "rotateRefreshToken" | "expiresWithSession">;
  features: Pick<NonNullable<Configuration["features"]>, "resourceIndicators" | "revocation">;
} {
  const resources = resourcesOf(issuer);
  const scopes = new Map<string, Scope>([
    [resources.mcp, "read"],
    [resources.bridge, "ingest"],
  ]);
  return {
    settings: {
      // oidc-provider's own. `read` and `ingest` belong to their resources.
      scopes: ["openid", "offline_access"],
      ttl: {
        AccessToken: lifetimes.accessTokenSeconds,
        RefreshToken: lifetimes.refreshTokenSeconds,
        Grant: lifetimes.grantSeconds,
      },
      issueRefreshToken: (_ctx, client) => client.grantTypeAllowed("refresh_token"),
      rotateRefreshToken: true,
      expiresWithSession: () => false,
    },
    features: {
      resourceIndicators: {
        enabled: true,
        defaultResource: (ctx, _client, oneOf) => oneOf ?? flowResource(ctx, resources),
        useGrantedResource: () => true,
        // At the start of a sign-in, this is also where the flow's scope is
        // checked: every request gets a resource there (`defaultResource`).
        getResourceServerInfo: (ctx, resource) => {
          const scope = scopes.get(resource);
          if (scope === undefined) throw new errors.InvalidTarget();
          const allowed = flowResource(ctx, resources);
          if (allowed !== undefined) {
            if (allowed !== resource) throw new errors.InvalidTarget("this sign-in flow cannot ask for that resource");
            const other = scope === "read" ? "ingest" : "read";
            if (ctx.oidc.requestParamScopes.has(other)) throw new errors.InvalidScope("this sign-in flow cannot ask for that scope", other);
          }
          return { scope, accessTokenFormat: "opaque" };
        },
      },
      revocation: { enabled: true },
    },
  };
}

/** What `requireToken` leaves for the route, in `res.locals`. */
export interface VerifiedToken {
  /** `users.uuid` of the user the token acts for. */
  userUuid: string;
  /** The OAuth client the token was issued to. */
  clientId: string;
  /** The grant the token belongs to. Revoking it ends the token. */
  grantId: string;
  scopes: string[];
}

const TOKEN = "ogmcpToken";

/** The access token `requireToken` accepted for this request, or null. */
export function currentToken(res: Response): VerifiedToken | null {
  return (res.locals[TOKEN] as VerifiedToken | undefined) ?? null;
}

export interface RequireTokenOptions {
  provider: Provider;
  /** The resource the route belongs to, from `resourcesOf`. */
  resource: string;
  /** The scope the route needs. */
  scope: Scope;
  /**
   * More auth-params for every `WWW-Authenticate` challenge sent, after the
   * error ones of RFC 6750. `/mcp` passes `resource_metadata` (RFC 9728, §9).
   */
  challenge?: Readonly<Record<string, string>>;
}

/** An RFC 6750 bearer credential. */
const BEARER = /^Bearer +([A-Za-z0-9._~+/-]+=*) *$/i;

/**
 * Accepts a request whose `Authorization: Bearer` access token is for
 * `resource`, carries `scope`, has not expired, and whose grant is live and
 * matches it. Otherwise it answers with an RFC 6750 challenge and no body:
 *
 * - 401 without an error code when the request has no bearer token.
 * - 401 `invalid_token` for a malformed, unknown, expired, or revoked token,
 *   or a token for another resource.
 * - 403 `insufficient_scope` for a token for this resource without `scope`.
 *
 * Every challenge ends with the `challenge` params and `scope`. A DPoP-bound
 * token is refused: this checks bearer tokens only.
 */
export function requireToken({ provider, resource, scope, challenge = {} }: RequireTokenOptions): RequestHandler {
  function deny(res: Response, status: 401 | 403, error?: "invalid_token" | "insufficient_scope", description?: string): void {
    const params: Record<string, string> = {
      ...(error === undefined ? {} : { error }),
      ...(description === undefined ? {} : { error_description: description }),
      ...challenge,
      scope,
    };
    const list = Object.entries(params).map(([name, value]) => `${name}="${value.replace(/["\\]/g, "\\$&")}"`);
    res.set("WWW-Authenticate", `Bearer ${list.join(", ")}`);
    res.set("Cache-Control", "no-store");
    res.status(status).end();
  }

  return async (req, res, next) => {
    const header = req.get("authorization");
    if (header === undefined || !/^Bearer(?: |$)/i.test(header)) return deny(res, 401);
    const value = BEARER.exec(header)?.[1];
    // find allows oidc-provider's clock tolerance past the expiry. Here the
    // issuer is the same service, so the expiry is exact.
    const token = value === undefined ? undefined : await provider.AccessToken.find(value);
    const clientId = token?.clientId;
    if (token === undefined || token.isExpired || clientId === undefined || token.aud !== resource || token.isSenderConstrained()) {
      return deny(res, 401, "invalid_token", "the access token is not valid here");
    }
    const grant = await provider.Grant.find(token.grantId);
    if (grant === undefined || grant.clientId !== clientId || grant.accountId !== token.accountId) {
      return deny(res, 401, "invalid_token", "the access token is not valid here");
    }
    if (!token.scopes.has(scope)) {
      return deny(res, 403, "insufficient_scope", `the access token does not carry the ${scope} scope`);
    }
    const verified: VerifiedToken = {
      userUuid: token.accountId,
      clientId,
      grantId: token.grantId,
      scopes: [...token.scopes],
    };
    res.locals[TOKEN] = verified;
    next();
  };
}
