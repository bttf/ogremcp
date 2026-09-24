import express, { type RequestHandler, type Router } from "express";
import type { Pool } from "pg";

import type { ProviderName } from "./identities.js";
import type { KitRegistry } from "./kits/registry.js";
import { requireSameOrigin } from "./same-origin.js";
import type { SignInProviders } from "./sign-in-providers.js";
import { currentUser } from "./web-sessions.js";

export interface ApiOptions {
  pool: Pool;
  providers: SignInProviders;
  /** `PUBLIC_BASE_URL`. State-changing requests must come from its origin. */
  publicBaseUrl: string;
  /** The first-class kits. Left out, the `/api/v1/games` routes are not served. */
  kits?: KitRegistry;
}

/** What `GET /api/v1/me` answers for a signed-in user. */
export interface Me {
  /** `users.uuid`. The serial id never leaves the service (§11). */
  uuid: string;
  /** The sign-in providers linked to the user, oldest first. */
  providers: ProviderName[];
}

/** One first-class kit on the Games page (§13.2). */
export interface Game {
  /** The manifest's `kit`, e.g. `wow`. */
  kit: string;
  /** E.g. `World of Warcraft`. */
  name: string;
  /** Whether the user has enabled it: a `user_games` row (§11). */
  enabled: boolean;
}

/**
 * The JSON API of the web UI (§13.2). The web session middleware must run
 * before this router. Every answer is `no-store`.
 *
 * - `GET /api/v1/me`: the signed-in user, or 401 `signed_out`.
 * - `GET /api/v1/sign-in-providers`: the providers this server has
 *   credentials for, so the Sign in page can say which are off. Their
 *   `/auth/<provider>` routes answer 503.
 * - `GET /api/v1/games`: `{ games: Game[] }`, every first-class kit in
 *   registry order, for the signed-in user.
 * - `PUT` and `DELETE /api/v1/games/:kit`: enable and disable a kit for the
 *   signed-in user, and answer its `Game`. Both are idempotent. They need
 *   this site's `Origin`, and answer 404 `unknown_kit` for a kit the registry
 *   does not hold.
 *
 * The games routes answer 401 `signed_out` without a web session. Any other
 * path under `/api` answers a JSON 404.
 */
export function apiRouter({ pool, providers, publicBaseUrl, kits }: ApiOptions): Router {
  const router = express.Router();

  router.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
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

  if (kits !== undefined) {
    router.get("/api/v1/games", async (_req, res) => {
      const user = currentUser(res);
      if (user === null) {
        res.status(401).json({ error: "signed_out" });
        return;
      }
      const { rows } = await pool.query<{ kit: string }>("select kit from user_games where user_id = $1", [user.id]);
      const enabled = new Set(rows.map((row) => row.kit));
      const games: Game[] = kits.list().map(({ key, name }) => ({ kit: key, name, enabled: enabled.has(key) }));
      res.json({ games });
    });

    const setEnabled =
      (enable: boolean): RequestHandler<{ kit: string }> =>
      async (req, res) => {
        const user = currentUser(res);
        if (user === null) {
          res.status(401).json({ error: "signed_out" });
          return;
        }
        const kit = kits.get(req.params.kit);
        if (kit === undefined) {
          res.status(404).json({ error: "unknown_kit" });
          return;
        }
        await pool.query(
          enable
            ? "insert into user_games (user_id, kit) values ($1, $2) on conflict (user_id, kit) do nothing"
            : "delete from user_games where user_id = $1 and kit = $2",
          [user.id, kit.key],
        );
        const game: Game = { kit: kit.key, name: kit.name, enabled: enable };
        res.json(game);
      };
    const sameOrigin = requireSameOrigin(publicBaseUrl);
    router.put("/api/v1/games/:kit", sameOrigin, setEnabled(true));
    router.delete("/api/v1/games/:kit", sameOrigin, setEnabled(false));
  }

  router.use("/api", (_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  return router;
}
