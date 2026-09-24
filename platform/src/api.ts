import express, { type Router } from "express";
import type { Pool } from "pg";

import type { ProviderName } from "./identities.js";
import type { SignInProviders } from "./sign-in-providers.js";
import { currentUser } from "./web-sessions.js";

export interface ApiOptions {
  pool: Pool;
  providers: SignInProviders;
}

/** What `GET /api/v1/me` answers for a signed-in user. */
export interface Me {
  /** `users.uuid`. The serial id never leaves the service (§11). */
  uuid: string;
  /** The sign-in providers linked to the user, oldest first. */
  providers: ProviderName[];
}

/**
 * The JSON API of the web UI (§13.2). The web session middleware must run
 * before this router. Every answer is `no-store` and `nosniff`.
 *
 * - `GET /api/v1/me`: the signed-in user, or 401 `signed_out`.
 * - `GET /api/v1/sign-in-providers`: the providers this server has
 *   credentials for, so the Sign in page can say which are off. Their
 *   `/auth/<provider>` routes answer 503.
 *
 * Any other path under `/api` answers a JSON 404.
 */
export function apiRouter({ pool, providers }: ApiOptions): Router {
  const router = express.Router();

  router.use("/api", (_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    next();
  });

  router.get("/api/v1/me", async (_req, res) => {
    const user = currentUser(res);
    if (user === null) {
      res.status(401).json({ error: "signed_out" });
      return;
    }
    const { rows } = await pool.query<{ provider: ProviderName }>(
      "select provider from oauth_identities where user_id = $1 order by created_at, id",
      [user.id],
    );
    const me: Me = { uuid: user.uuid, providers: rows.map((row) => row.provider) };
    res.json(me);
  });

  router.get("/api/v1/sign-in-providers", (_req, res) => {
    res.json({ providers: (["google", "discord"] as const).filter((name) => providers[name] !== null) });
  });

  router.use("/api", (_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  return router;
}
