import { timingSafeEqual } from "node:crypto";

import express, { type CookieOptions, type Response, type Router } from "express";
import type { Pool } from "pg";

import { readCookie } from "./cookies.js";
import { linkIdentity, type ProviderName, signInWithIdentity } from "./identities.js";
import { requireSameOrigin } from "./same-origin.js";
import { SignInFailure, type SignInProviders } from "./sign-in-providers.js";
import { currentUser, type WebSessions } from "./web-sessions.js";

/**
 * Sign-in and sign-out for the web UI (§13.1). The web session middleware
 * must run before this router.
 *
 * - `GET /auth/{google,discord}` sends the browser to the provider. With
 *   `?link=1`, from a signed-in browser, it connects the provider's account
 *   to the signed-in user instead of signing in. That is the only way a
 *   second provider joins a user.
 * - `GET /auth/{google,discord}/callback` finishes either flow and redirects
 *   to `/`. A sign-in whose identity is new creates a user; a sign-in replaces
 *   any web session the browser had.
 * - `POST /auth/signout` ends the web session and redirects to `/`. It needs
 *   this site's `Origin`.
 *
 * A provider without credentials answers 503. Failures answer with a status
 * and a plain-text sentence; the sign-in page (RED-296) comes later.
 */
export interface AuthOptions {
  pool: Pool;
  sessions: WebSessions;
  providers: SignInProviders;
  /** `PUBLIC_BASE_URL`. */
  publicBaseUrl: string;
  /** Receives one line per failed exchange with a provider. Default: `console.error`. */
  log?: (line: string) => void;
}

/**
 * Holds `state`, the PKCE code verifier (empty for Discord), and, for a link,
 * the uuid of the web session that started it, joined by dots. Every part is
 * base64url or a uuid, so none holds a dot. The cookie is sent only to the
 * provider's callback path.
 */
const SIGN_IN_COOKIE = "ogmcp_signin";

/** How long a sign-in may take at the provider. */
export const SIGN_IN_TTL_MS = 10 * 60 * 1000;

const PROVIDERS: readonly ProviderName[] = ["google", "discord"];

function sendText(res: Response, status: number, text: string): void {
  res.status(status).type("text/plain").send(text);
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function authRouter({ pool, sessions, providers, publicBaseUrl, log = console.error }: AuthOptions): Router {
  const router = express.Router();

  const signInCookie = (name: ProviderName): CookieOptions => ({
    httpOnly: true,
    secure: sessions.secure,
    sameSite: "lax",
    path: `/auth/${name}/callback`,
  });

  router.use("/auth", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  for (const name of PROVIDERS) {
    router.get(`/auth/${name}`, async (req, res) => {
      const provider = providers[name];
      if (provider === null) return sendText(res, 503, `Sign-in with ${label(name)} is not configured on this server.`);
      let linkSession = "";
      if (req.query["link"] === "1") {
        const user = currentUser(res);
        if (user === null) return sendText(res, 401, `Sign in first, then connect your ${provider.label} account.`);
        linkSession = user.sessionUuid;
      }
      let flow: Awaited<ReturnType<typeof provider.begin>>;
      try {
        flow = await provider.begin();
      } catch (err) {
        if (!(err instanceof SignInFailure)) throw err;
        log(`sign-in with ${name} could not start: ${err.kind}: ${err.reason}`);
        return sendText(res, 502, `Could not reach ${provider.label} to start signing in. Try again.`);
      }
      res.cookie(SIGN_IN_COOKIE, [flow.state, flow.codeVerifier ?? "", linkSession].join("."), {
        ...signInCookie(name),
        maxAge: SIGN_IN_TTL_MS,
      });
      res.redirect(flow.url.toString());
    });

    router.get(`/auth/${name}/callback`, async (req, res) => {
      const provider = providers[name];
      if (provider === null) return sendText(res, 503, `Sign-in with ${label(name)} is not configured on this server.`);
      const stored = readCookie(req, SIGN_IN_COOKIE)?.split(".");
      res.clearCookie(SIGN_IN_COOKIE, signInCookie(name));

      if (req.query["error"] !== undefined) {
        return sendText(res, 400, `Sign-in with ${provider.label} was cancelled or refused. Start again from the sign-in page.`);
      }
      const code = req.query["code"];
      const state = req.query["state"];
      const [storedState, storedVerifier, linkSession] = stored?.length === 3 ? stored : [];
      if (
        typeof code !== "string" ||
        typeof state !== "string" ||
        storedState === undefined ||
        storedVerifier === undefined ||
        linkSession === undefined ||
        !sameText(state, storedState)
      ) {
        return sendText(res, 400, `Sign-in with ${provider.label} could not be verified. Start again from the sign-in page.`);
      }

      let providerUserId: string;
      try {
        providerUserId = await provider.finish(new URL(req.originalUrl, publicBaseUrl).searchParams, {
          state: storedState,
          codeVerifier: storedVerifier === "" ? null : storedVerifier,
        });
      } catch (err) {
        if (!(err instanceof SignInFailure)) throw err;
        log(`sign-in with ${name} failed: ${err.kind}: ${err.reason}`);
        return err.kind === "refused"
          ? sendText(res, 400, `${provider.label} did not confirm the sign-in. Start again from the sign-in page.`)
          : sendText(res, 502, `Could not reach ${provider.label} to finish signing in. Try again.`);
      }

      const user = currentUser(res);
      if (linkSession !== "") {
        if (user === null || user.sessionUuid !== linkSession) {
          return sendText(res, 401, `You were signed out before your ${provider.label} account was connected. Sign in and try again.`);
        }
        const result = await linkIdentity(pool, user.id, name, providerUserId);
        if (result === "other user") {
          return sendText(
            res,
            409,
            `This ${provider.label} account is already linked to another Open Gamer MCP account, so it was not connected to yours. Accounts are never merged.`,
          );
        }
        return res.redirect("/");
      }

      const userId = await signInWithIdentity(pool, name, providerUserId);
      if (user !== null) await sessions.invalidate(user.sessionUuid);
      const { token, expiresAt } = await sessions.create(userId);
      sessions.setCookie(res, token, expiresAt);
      res.redirect("/");
    });
  }

  router.post("/auth/signout", requireSameOrigin(publicBaseUrl), async (_req, res) => {
    const user = currentUser(res);
    if (user !== null) await sessions.invalidate(user.sessionUuid);
    sessions.clearCookie(res);
    res.redirect(303, "/");
  });

  return router;
}

function label(name: ProviderName): string {
  return name === "google" ? "Google" : "Discord";
}
