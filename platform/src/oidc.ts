import type { EventEmitter } from "node:events";

import express, { type Express, type Request, type Response, type Router } from "express";
import Provider, { type Account, type Configuration, errors, type Interaction, interactionPolicy } from "oidc-provider";
import type { Pool } from "pg";

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
 * `/.well-known/openid-configuration`. Only those paths reach
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
 * Off here, each for its own issue: dynamic client registration (RED-304),
 * static clients (RED-305), client ID metadata documents (RED-306), the
 * device flow (RED-307), loopback redirects (RED-308). oidc-provider's
 * defaults stand for scopes, resource indicators, and token lifetimes
 * (RED-302), and for discovery (RED-301). The consent page is RED-303.
 */

/**
 * The path every oidc-provider endpoint this service serves is under, but
 * discovery. Only these paths and `DISCOVERY_PATH` reach oidc-provider.
 */
export const OIDC_PATH_PREFIX = "/oauth/";

/** oidc-provider serves the discovery document here. RED-301 adds `/.well-known/oauth-authorization-server`. */
export const DISCOVERY_PATH = "/.well-known/openid-configuration";

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
   * `TRUST_PROXY_HOPS`, as Express has it. Above 0, oidc-provider trusts
   * `X-Forwarded-Proto`, so behind Railway's edge its endpoint URLs are
   * https, and reads the client address that many hops back.
   */
  trustProxyHops: number;
  /** Receives one line per server error. Default: `console.error`. */
  log?: (line: string) => void;
}

/** The provider, configured. `mountOidc` serves it. */
export function createOidcProvider({ pool, issuer, keys, trustProxyHops, log = console.error }: OidcOptions): Provider {
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
    },
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
 */
export function mountOidc(app: Express, provider: Provider, pool: Pool): void {
  const callback = provider.callback();
  app.use((req, res, next) => {
    if (req.path === DISCOVERY_PATH || req.path.startsWith(OIDC_PATH_PREFIX)) {
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

function signInRedirect(interaction: Interaction): string {
  return `${SIGN_IN_PATH}?return_to=${encodeURIComponent(`/interaction/${interaction.uid}`)}`;
}

/**
 * - `GET /interaction/:uid`, where oidc-provider sends the browser. Signed
 *   out, it goes to sign in and comes back here. Signed in, a login prompt is
 *   completed with the user's uuid and the time of the sign-in, and the
 *   browser goes back to oidc-provider. The consent prompt is RED-303's page;
 *   until then it answers 501.
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
      const { rows } = await pool.query<{ ts: string }>(
        "select floor(extract(epoch from created_at))::bigint as ts from web_sessions where uuid = $1",
        [user.sessionUuid],
      );
      const ts = rows[0] === undefined ? undefined : Number(rows[0].ts);
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
