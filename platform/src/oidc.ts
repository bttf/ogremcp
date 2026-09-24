import type { EventEmitter } from "node:events";

import express, { type Express, type Request, type Response, type Router } from "express";
import Provider, { type Account, type Configuration, errors, type Interaction, interactionPolicy } from "oidc-provider";
import type { Pool } from "pg";

import { type CimdFetchLimits, clientIdMetadataDocument, DEFAULT_CIMD_FETCH_LIMITS } from "./cimd.js";
import { failureCode } from "./db.js";
import { postgresAdapter } from "./oidc-adapter.js";
import type { OidcKeys } from "./oidc-keys.js";
import { currentUser } from "./web-sessions.js";

/**
 * The OAuth authorization server for agents and bridges (§8.1, §9, §13.1):
 * `oidc-provider` mounted in the Express app, storing its models in Postgres
 * (`oidc-adapter.ts`).
 *
 * Its endpoints live under `/oauth/`, and its discovery document at
 * `/.well-known/openid-configuration` and
 * `/.well-known/oauth-authorization-server` (RFC 8414). Only those paths reach
 * oidc-provider: every other request stays with Express, and oidc-provider
 * reads the request body only on its own paths. `/device`, the device flow's
 * page, does not reach it yet (RED-307).
 *
 * The web session is the login. An authorization request whose browser has
 * no web session, or a web session of another user, is sent to
 * `/interaction/:uid`, which sends a signed-out browser to sign in and back,
 * and completes the login prompt with the signed-in user's uuid as the
 * account id.
 *
 * Client ID metadata documents are on (`cimd.ts`, RED-306). Off here, each
 * for its own issue: dynamic client registration (RED-304), static clients
 * (RED-305), the device flow (RED-307), loopback redirects (RED-308).
 * oidc-provider's defaults stand for scopes, resource indicators, and token
 * lifetimes (RED-302). The consent page is RED-303. The MCP endpoint's
 * resource metadata is `mcp.ts`.
 */

/**
 * The path every oidc-provider endpoint this service serves is under, but
 * discovery. Only these paths and `DISCOVERY_PATHS` reach oidc-provider.
 */
export const OIDC_PATH_PREFIX = "/oauth/";

/**
 * oidc-provider serves the same metadata document at both (§9): OpenID
 * Connect Discovery, and OAuth 2.0 Authorization Server Metadata (RFC 8414).
 * MCP clients ask for the second first.
 */
export const DISCOVERY_PATHS: readonly string[] = ["/.well-known/openid-configuration", "/.well-known/oauth-authorization-server"];

/**
 * The web UI's Sign in page (§13.2). A signed-out browser in an OAuth
 * interaction goes here with `?return_to=/interaction/:uid`, and the page
 * passes `return_to` on to `/auth/{google,discord}`.
 */
export const SIGN_IN_PATH = "/signin";

/**
 * oidc-provider's endpoint paths. Its defaults collide with the web UI:
 * `/auth/:uid` (resume) with sign-in's `/auth/google`, so every endpoint
 * moves under `/oauth/`. The device flow's page stays at `/device`, the
 * web UI's device approval page (§8.1, §13.2); the device flow is off, and
 * RED-307 decides how that page is served. The last three belong to
 * features that are off.
 */
const ROUTES = {
  authorization: "/oauth/authorize",
  token: "/oauth/token",
  registration: "/oauth/register",
  jwks: "/oauth/jwks",
  userinfo: "/oauth/me",
  revocation: "/oauth/revoke",
  introspection: "/oauth/introspect",
  end_session: "/oauth/logout",
  device_authorization: "/oauth/device/auth",
  pushed_authorization_request: "/oauth/par",
  code_verification: "/device",
  backchannel_authentication: "/oauth/backchannel",
  challenge: "/oauth/challenge",
  credential: "/oauth/credential",
} as const satisfies Configuration["routes"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface OidcOptions {
  pool: Pool;
  /** `PUBLIC_BASE_URL`: the issuer identifier. */
  issuer: string;
  keys: OidcKeys;
  /**
   * `TRUST_PROXY_HOPS`, as Express has it. Above 0, oidc-provider reads the
   * client address that many hops back, and builds its endpoint URLs from
   * `X-Forwarded-Proto` and `X-Forwarded-Host`, which `mountOidc` sets from
   * the issuer. So behind Railway's edge they are https.
   */
  trustProxyHops: number;
  /**
   * Receives one line per server error, and one per minute in which client ID
   * metadata document fetches go over their limit. Default: `console.error`.
   */
  log?: (line: string) => void;
  /** `CIMD_FETCHES_PER_MINUTE` and `CIMD_FETCHES_PER_HOST_PER_MINUTE`. Default: `DEFAULT_CIMD_FETCH_LIMITS`. */
  cimdFetchLimits?: CimdFetchLimits;
  /**
   * Tests only; `index.ts` never sets it. It replaces oidc-provider's
   * `fetch`, which fetches client ID metadata documents. oidc-provider passes
   * it `init.dispatcher`, its agent that refuses private, loopback, and
   * link-local addresses (SSRF). A test that serves a document from a local
   * server fetches it without that agent.
   */
  testOnlyFetch?: Configuration["fetch"];
}

/** The provider, configured. `mountOidc` serves it. */
export function createOidcProvider({
  pool,
  issuer,
  keys,
  trustProxyHops,
  log = console.error,
  cimdFetchLimits = DEFAULT_CIMD_FETCH_LIMITS,
  testOnlyFetch,
}: OidcOptions): Provider {
  const configuration: Configuration = {
    adapter: postgresAdapter(pool),
    jwks: keys.jwks,
    cookies: { keys: keys.cookieKeys },
    findAccount: (_ctx, sub) => findAccount(pool, sub),
    interactions: {
      policy: interactionPolicyWithWebSession(),
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
    },
    routes: ROUTES,
    // §9: OAuth 2.1 with PKCE only, for every client.
    pkce: { required: () => true },
    features: {
      // oidc-provider's built-in login pages, for development only.
      devInteractions: { enabled: false },
      // §9, D7: URL-based client IDs.
      clientIdMetadataDocument: clientIdMetadataDocument(cimdFetchLimits, log),
    },
    ...(testOnlyFetch === undefined ? {} : { fetch: testOnlyFetch }),
  };
  let provider: Provider;
  try {
    provider = new Provider(issuer, configuration);
  } catch (err) {
    // The error's cause can hold the key it rejected, so only the message goes on.
    throw new Error(`the OAuth server did not start: ${(err as Error).message}`);
  }
  provider.proxy = trustProxyHops > 0;
  provider.maxIpsCount = trustProxyHops;
  // A code only: a Postgres message can repeat a row (`failureCode`).
  provider.on("server_error", (ctx: { method: string; path: string }, err: unknown) => {
    log(`oauth server error: ${ctx.method} ${ctx.path} code=${failureCode(err)}`);
  });
  // Errors Koa sees itself, such as a connection that failed. Without a
  // listener, Koa prints the stack. oidc-provider's types leave the event out.
  (provider as unknown as EventEmitter).on("error", (err: unknown) => {
    if ((err as { expose?: unknown } | null)?.expose === true) return;
    log(`oauth error: code=${failureCode(err)}`);
  });
  return provider;
}

/**
 * Serves the provider's paths, then the interaction routes. Mount it after
 * the web session middleware, which the interactions read, and before any
 * body parser, so that oidc-provider reads its own request bodies.
 *
 * Koa takes the leftmost `X-Forwarded-Host` and `X-Forwarded-Proto` whatever
 * the hop count, and a client can write those. So before oidc-provider runs,
 * both are set from the issuer, and every endpoint URL it builds is on the
 * issuer's origin.
 */
export function mountOidc(app: Express, provider: Provider, pool: Pool): void {
  const callback = provider.callback();
  const issuer = new URL(provider.issuer);
  app.use((req, res, next) => {
    if (DISCOVERY_PATHS.includes(req.path) || req.path.startsWith(OIDC_PATH_PREFIX)) {
      req.headers["x-forwarded-host"] = issuer.host;
      req.headers["x-forwarded-proto"] = issuer.protocol.slice(0, -1);
      void callback(req, res);
      return;
    }
    next();
  });
  app.use(interactionRouter(provider, pool));
}

/** The account of a user's uuid, while the user exists. The uuid is the subject (§11). */
async function findAccount(pool: Pool, sub: string): Promise<Account | undefined> {
  if (!UUID.test(sub)) return undefined;
  const { rows } = await pool.query("select 1 from users where uuid = $1", [sub]);
  if (rows.length === 0) return undefined;
  return { accountId: sub, claims: () => ({ sub }) };
}

/**
 * oidc-provider's default policy, with one more login check: the browser's
 * web session must belong to the account oidc-provider has signed in. So a
 * browser that signed out of the web UI, or signed in as someone else, goes
 * through the login prompt again.
 */
function interactionPolicyWithWebSession(): interactionPolicy.DefaultPolicy {
  const policy = interactionPolicy.base();
  const login = policy.get("login");
  if (login === undefined) throw new Error("oidc-provider's default policy has no login prompt");
  login.checks.add(
    new interactionPolicy.Check("web_session", "the web session is not the authenticated account's", (ctx) => {
      // oidc-provider runs on the Express response, where the web session middleware left the user.
      const user = currentUser(ctx.res as unknown as Response);
      return user === null || user.uuid !== ctx.oidc.session?.accountId;
    }),
  );
  return policy;
}

function sendText(res: Response, status: number, text: string): void {
  res.status(status).type("text/plain").send(text);
}

const EXPIRED = "This authorization request has expired or is not valid. Start again from your agent.";

/**
 * The interaction of the browser's interaction cookie, when it is the one in
 * the path. oidc-provider sets that cookie on the path `/interaction/:uid`, so
 * every interaction route is under it.
 */
async function findInteraction(provider: Provider, req: Request, res: Response): Promise<Interaction | null> {
  let interaction: Interaction;
  try {
    interaction = await provider.interactionDetails(req, res);
  } catch (err) {
    if (err instanceof errors.SessionNotFound) return null;
    throw err;
  }
  return interaction.uid === req.params["uid"] ? interaction : null;
}

/**
 * Whether the login prompt asks for more than the web session's sign-in at
 * `signedInAt` (seconds since the epoch). `prompt=login` asks for a sign-in
 * made during this request. An exceeded `max_age` accepts that, or a sign-in
 * within `max_age` seconds. A sign-in made during the request satisfies both,
 * so the browser comes back from it and goes on.
 */
function needsFreshSignIn(interaction: Interaction, signedInAt: number | undefined): boolean {
  const { reasons } = interaction.prompt;
  if (!reasons.includes("login_prompt") && !reasons.includes("max_age")) return false;
  if (signedInAt === undefined) return true;
  if (signedInAt >= interaction.iat) return false;
  if (reasons.includes("login_prompt")) return true;
  const maxAge = Number(interaction.params["max_age"]);
  return !(Number.isFinite(maxAge) && Math.floor(Date.now() / 1000) - signedInAt <= maxAge);
}

function signInRedirect(interaction: Interaction): string {
  return `${SIGN_IN_PATH}?return_to=${encodeURIComponent(`/interaction/${interaction.uid}`)}`;
}

/**
 * - `GET /interaction/:uid`, where oidc-provider sends the browser. Signed
 *   out, it goes to sign in and comes back here. Signed in, a login prompt is
 *   completed with the user's uuid and the time of the sign-in, and the
 *   browser goes back to oidc-provider. When the request asks for a fresh
 *   login (`needsFreshSignIn`), a sign-in from before it does not count: the
 *   browser goes through sign-in again first. The consent prompt is RED-303's
 *   page; until then it answers 501.
 * - `GET /interaction/:uid/details`, JSON for that page: the prompt, the
 *   client, and what it asks for. It answers only the user the interaction
 *   belongs to.
 */
function interactionRouter(provider: Provider, pool: Pool): Router {
  const router = express.Router();

  router.use("/interaction", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.get("/interaction/:uid", async (req, res) => {
    const interaction = await findInteraction(provider, req, res);
    if (interaction === null) return sendText(res, 400, EXPIRED);
    const user = currentUser(res);
    if (user === null) return res.redirect(303, signInRedirect(interaction));
    if (interaction.prompt.name === "login" || interaction.session?.accountId !== user.uuid) {
      // A web session starts at sign-in, and renewal keeps its created_at.
      const { rows } = await pool.query<{ ts: string }>(
        "select floor(extract(epoch from created_at))::bigint as ts from web_sessions where uuid = $1",
        [user.sessionUuid],
      );
      const ts = rows[0] === undefined ? undefined : Number(rows[0].ts);
      if (needsFreshSignIn(interaction, ts)) return res.redirect(303, signInRedirect(interaction));
      const returnTo = await provider.interactionResult(req, res, { login: { accountId: user.uuid, ts } });
      return res.redirect(303, returnTo);
    }
    return sendText(res, 501, "Approving an agent is not available yet.");
  });

  router.get("/interaction/:uid/details", async (req, res) => {
    const interaction = await findInteraction(provider, req, res);
    if (interaction === null) return res.status(400).json({ error: "interaction_not_found" });
    const user = currentUser(res);
    if (user === null) return res.status(401).json({ error: "signed_out", sign_in: signInRedirect(interaction) });
    if (interaction.session?.accountId !== user.uuid) return res.status(403).json({ error: "other_account" });
    const clientId = String(interaction.params["client_id"]);
    const client = await provider.Client.find(clientId);
    res.json({
      uid: interaction.uid,
      prompt: interaction.prompt,
      client_id: clientId,
      client_name: client?.metadata().client_name ?? null,
      redirect_uri: interaction.params["redirect_uri"] ?? null,
      scope: interaction.params["scope"] ?? null,
    });
  });

  return router;
}
