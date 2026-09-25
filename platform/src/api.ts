import express, { type RequestHandler, type Router } from "express";
import type Provider from "oidc-provider";
import type { Pool } from "pg";

import { deleteAccount, deleteUserData } from "./account.js";
import { listAgentGrants, revokeAgentGrant } from "./agents.js";
import { deviceName, findDevice, listDevices, renameDevice, revokeDevice } from "./devices.js";
import type { ProviderName } from "./identities.js";
import { DEFAULT_INGEST, type DeviceLimits } from "./ingest.js";
import type { KitRegistry } from "./kits/registry.js";
import { mcpResource } from "./mcp.js";
import { DEFAULT_RETENTION } from "./retention.js";
import { requireSameOrigin } from "./same-origin.js";
import type { SignInProviders } from "./sign-in-providers.js";
import { NO_TOOL_CALL_CAPS, type ToolCallCaps } from "./usage.js";
import { currentUser, type WebSessions } from "./web-sessions.js";

export interface ApiOptions {
  pool: Pool;
  /** Web sessions, whose cookie "Delete account" clears. */
  sessions: WebSessions;
  providers: SignInProviders;
  /** `PUBLIC_BASE_URL`. State-changing requests must come from its origin. */
  publicBaseUrl: string;
  /** The first-class kits. Left out, the `/api/v1/games` routes are not served. */
  kits?: KitRegistry;
  /** The OAuth server (§9), which reads agent clients' names. Left out, the `/api/v1/agents` routes are not served. */
  oidc?: Provider;
  /** `BRIDGE_DOWNLOAD_URL`. Left out or null, `GET /api/v1/setup` answers null for it. */
  bridgeDownloadUrl?: string | null;
  /** The limits `GET /api/v1/account` reports. Default: `DEFAULT_TIER_LIMITS`. */
  tierLimits?: TierLimits;
}

/**
 * The limits of each tier (§14), as the platform enforces them: the device
 * limit (`ingest.ts`), the daily tool-call cap (`usage.ts`), and the free
 * tier's history retention (`retention.ts`). A paid user keeps their history
 * forever.
 */
export interface TierLimits {
  /** `DEVICES_PER_USER_FREE` and `DEVICES_PER_USER_PAID`. */
  devicesPerUser: DeviceLimits;
  /** `TOOL_CALLS_PER_DAY_FREE` and `TOOL_CALLS_PER_DAY_PAID`. */
  toolCallCaps: ToolCallCaps;
  /** `FREE_RETENTION_DAYS`. Null is forever. */
  freeRetentionDays: number | null;
}

/** Each limit's default, as `config.ts` has it when its name is unset. */
export const DEFAULT_TIER_LIMITS: TierLimits = {
  devicesPerUser: DEFAULT_INGEST.devicesPerUser,
  toolCallCaps: NO_TOOL_CALL_CAPS,
  freeRetentionDays: DEFAULT_RETENTION.freeRetentionDays,
};

/** What `GET /api/v1/me` answers for a signed-in user. */
export interface Me {
  /** `users.uuid`. The serial id never leaves the service (§11). */
  uuid: string;
  /** The sign-in providers linked to the user, oldest first. */
  providers: ProviderName[];
}

/** What `GET /api/v1/setup` answers: the links of the Get started and Connect your agent pages (§13.2). */
export interface Setup {
  /** `<PUBLIC_BASE_URL>/mcp`, the one URL every agent connects to (§1, §9). */
  mcp_url: string;
  /** `BRIDGE_DOWNLOAD_URL`, or null when the bridge has no download yet. */
  bridge_download_url: string | null;
}

/** What `GET /api/v1/account` answers: the signed-in user's tier and what applies to it (§13.2, §14). */
export interface AccountTier {
  /** `users.tier`. */
  tier: "free" | "paid";
  /** The most devices the user uploads from (§8.3), or null: no limit. */
  devices: number | null;
  /** The most MCP tool calls the user makes per UTC day, or null: no cap. */
  tool_calls_per_day: number | null;
  /** How many days of uploads and snapshots the user keeps (§11), or null: all of them. */
  history_days: number | null;
  /** Whether the user may call the paid-only history tools (`*_get_history`, `tools.ts`). */
  history_tools: boolean;
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
 * before this router. Every answer is `no-store`. The bridge API
 * (`bridge-api.ts`) shares the `/api/v1` prefix, and its routes take an
 * access token, not a web session.
 *
 * - `GET /api/v1/me`: the signed-in user, or 401 `signed_out`.
 * - `GET /api/v1/sign-in-providers`: the providers this server has
 *   credentials for, so the Sign in page can say which are off. Their
 *   `/auth/<provider>` routes answer 503.
 * - `GET /api/v1/setup`: the `Setup` links, for the signed-in user.
 * - `GET /api/v1/games`: `{ games: Game[] }`, every first-class kit in
 *   registry order, for the signed-in user.
 * - `PUT` and `DELETE /api/v1/games/:kit`: enable and disable a kit for the
 *   signed-in user, and answer its `Game`. Both are idempotent. They answer
 *   404 `unknown_kit` for a kit the registry does not hold.
 * - `GET /api/v1/devices`: `{ devices: DeviceInfo[] }`, the signed-in
 *   user's devices, revoked ones too (§8.1, `devices.ts`).
 * - `PATCH /api/v1/devices/:uuid`: renames the device to the JSON body's
 *   `name` (`deviceName`), and answers its `DeviceInfo`. An empty name or
 *   null resets it to the page's fallback. A name that `deviceName` refuses,
 *   or a body without `name`, answers 400 `invalid_name`.
 * - `DELETE /api/v1/devices/:uuid`: revokes the device, its grant, and the
 *   grant's tokens (`revokeDevice`), and answers its `DeviceInfo`. It is
 *   idempotent.
 * - `GET /api/v1/agents`: `{ agents: AgentGrant[] }`, the signed-in user's
 *   live agent grants (`agents.ts`).
 * - `DELETE /api/v1/agents/:id`: revokes the agent grant and all its tokens
 *   (`revokeAgentGrant`), and answers 204.
 * - `GET /api/v1/account`: the signed-in user's `AccountTier`, from
 *   `users.tier` and `tierLimits`.
 * - `DELETE /api/v1/account/data`: "Delete my data" (`deleteUserData`,
 *   §11). Answers 204.
 * - `DELETE /api/v1/account`: "Delete account" (`deleteAccount`, §11). It
 *   ends every web session of the user, clears the cookie, and answers 204.
 *
 * The device and agent routes answer 404 `not_found` for a uuid or id that
 * is not one of the signed-in user's devices or agent grants. The bridge's
 * grants are devices, never agents.
 *
 * The routes but `me` and `sign-in-providers` answer 401 `signed_out` without
 * a web session. Every route that changes something needs this site's
 * `Origin`. Any other path under `/api` answers a JSON 404.
 */
export function apiRouter({
  pool,
  sessions,
  providers,
  publicBaseUrl,
  kits,
  oidc,
  bridgeDownloadUrl = null,
  tierLimits = DEFAULT_TIER_LIMITS,
}: ApiOptions): Router {
  const router = express.Router();

  const sameOrigin = requireSameOrigin(publicBaseUrl);

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

  router.get("/api/v1/setup", (_req, res) => {
    if (currentUser(res) === null) {
      res.status(401).json({ error: "signed_out" });
      return;
    }
    const setup: Setup = { mcp_url: mcpResource(publicBaseUrl), bridge_download_url: bridgeDownloadUrl };
    res.json(setup);
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
    router.put("/api/v1/games/:kit", sameOrigin, setEnabled(true));
    router.delete("/api/v1/games/:kit", sameOrigin, setEnabled(false));
  }

  router.get("/api/v1/devices", async (_req, res) => {
    const user = currentUser(res);
    if (user === null) {
      res.status(401).json({ error: "signed_out" });
      return;
    }
    res.json({ devices: await listDevices(pool, user.id) });
  });

  const renameOwnDevice: RequestHandler<{ uuid: string }> = async (req, res) => {
    const user = currentUser(res);
    if (user === null) {
      res.status(401).json({ error: "signed_out" });
      return;
    }
    const body: unknown = req.body;
    const name = typeof body === "object" && body !== null && "name" in body ? deviceName(body.name) : undefined;
    if (name === undefined) {
      res.status(400).json({ error: "invalid_name" });
      return;
    }
    const device = await renameDevice(pool, user.id, req.params.uuid, name);
    if (device === null) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(device);
  };

  const revokeOwnDevice: RequestHandler<{ uuid: string }> = async (req, res) => {
    const user = currentUser(res);
    if (user === null) {
      res.status(401).json({ error: "signed_out" });
      return;
    }
    await revokeDevice(pool, user.id, req.params.uuid);
    const device = await findDevice(pool, user.id, req.params.uuid);
    if (device === null) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(device);
  };

  router.patch("/api/v1/devices/:uuid", sameOrigin, express.json({ limit: "1kb" }), renameOwnDevice);
  router.delete("/api/v1/devices/:uuid", sameOrigin, revokeOwnDevice);

  if (oidc !== undefined) {
    router.get("/api/v1/agents", async (_req, res) => {
      const user = currentUser(res);
      if (user === null) {
        res.status(401).json({ error: "signed_out" });
        return;
      }
      res.json({ agents: await listAgentGrants(pool, oidc, user.uuid) });
    });

    const revokeOwnAgent: RequestHandler<{ id: string }> = async (req, res) => {
      const user = currentUser(res);
      if (user === null) {
        res.status(401).json({ error: "signed_out" });
        return;
      }
      if (!(await revokeAgentGrant(pool, user.uuid, req.params.id))) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.status(204).end();
    };
    router.delete("/api/v1/agents/:id", sameOrigin, revokeOwnAgent);
  }

  router.get("/api/v1/account", async (_req, res) => {
    const user = currentUser(res);
    if (user === null) {
      res.status(401).json({ error: "signed_out" });
      return;
    }
    const { rows } = await pool.query<{ tier: AccountTier["tier"] }>("select tier from users where id = $1", [user.id]);
    const tier = rows[0]?.tier;
    if (tier === undefined) {
      res.status(401).json({ error: "signed_out" });
      return;
    }
    const account: AccountTier = {
      tier,
      devices: tierLimits.devicesPerUser[tier],
      tool_calls_per_day: tierLimits.toolCallCaps[tier],
      history_days: tier === "paid" ? null : tierLimits.freeRetentionDays,
      history_tools: tier === "paid",
    };
    res.json(account);
  });

  router.delete("/api/v1/account/data", sameOrigin, async (_req, res) => {
    const user = currentUser(res);
    if (user === null) {
      res.status(401).json({ error: "signed_out" });
      return;
    }
    await deleteUserData(pool, user);
    res.status(204).end();
  });

  router.delete("/api/v1/account", sameOrigin, async (_req, res) => {
    const user = currentUser(res);
    if (user === null) {
      res.status(401).json({ error: "signed_out" });
      return;
    }
    await deleteAccount(pool, user);
    sessions.clearCookie(res);
    res.status(204).end();
  });

  router.use("/api", (_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  return router;
}
