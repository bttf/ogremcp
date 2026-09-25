import express, { type RequestHandler, type Response, type Router } from "express";
import type Provider from "oidc-provider";
import type { Pool } from "pg";

import type { EventRecorder } from "./events.js";
import { DEFAULT_INGEST, ingestHandler, type IngestSettings } from "./ingest.js";
import type { Kit, KitRegistry } from "./kits/registry.js";
import { currentToken, requireToken, resourcesOf } from "./oidc-tokens.js";

/**
 * The bridge's endpoints (§8.2). The bridge fetches the manifests and
 * adapters of its user's enabled kits after login, at each start, and on a
 * timer (§7), and posts each changed source instance to the ingest endpoint
 * (§8.3).
 *
 * Every route needs an access token for the bridge API,
 * `<PUBLIC_BASE_URL>/api/v1`, with scope `ingest` (`requireToken`, §8.1). The
 * routes read no web session and make no same-origin check. A missing,
 * revoked, or `read` token gets 401 with an RFC 6750 challenge, and the bridge
 * prompts a new login. Every answer is `no-store`.
 *
 * - `GET /api/v1/kits`: a `KitList` of the user's enabled kits (`user_games`,
 *   §11) that the registry holds, in registry order.
 * - `GET /api/v1/kits/{kit}/manifest`: the kit's pinned `manifest.json` (§5,
 *   §6.1).
 * - `GET /api/v1/kits/{kit}/adapter`: the adapter zip the platform build made
 *   from `kits/{kit}/adapter` (§5), as `application/zip`, with its sha256 in
 *   `ADAPTER_SHA256_HEADER`.
 * - `POST /api/v1/ingest`: one upload of one source instance (`ingest.ts`).
 *
 * The manifest and adapter routes serve every kit in the registry, enabled or
 * not. They do not depend on tier or on the device limit: every approved
 * bridge may fetch them (§8.1, D10). A kit the registry does not hold gets 404
 * `unknown_kit`, and the adapter route of a kit without an adapter gets 404
 * `no_adapter`.
 */

/**
 * The header that carries the adapter zip's sha256, as lower-case hex. It is
 * the `adapter.sha256` of `GET /api/v1/kits`, unless a deploy came between
 * the two requests.
 */
export const ADAPTER_SHA256_HEADER = "X-Adapter-Sha256";

/**
 * The answer to `GET /api/v1/kits`. The bridge is Go, so the names are
 * snake_case, as in the ingest `meta` (§8.3):
 *
 * ```json
 * {
 *   "kits": [
 *     {
 *       "kit": "wow",
 *       "name": "World of Warcraft",
 *       "manifest_version": "0.1.0",
 *       "adapter": { "version": "0.1.0", "sha256": "<lower-case hex SHA-256 of the zip>" }
 *     }
 *   ]
 * }
 * ```
 */
export interface KitList {
  kits: KitListEntry[];
}

export interface KitListEntry {
  /** The manifest's `kit`, e.g. `wow`: the `{kit}` of the other two routes. */
  kit: string;
  /**
   * The kit's name from `KIT_NAMES`, e.g. `World of Warcraft`. The manifest
   * has none, and the bridge's tray names the game with it (§7).
   */
  name: string;
  /** The manifest's `version` (§6.1). */
  manifest_version: string;
  /** Null for a kit without an adapter (§6.1). */
  adapter: {
    /** The addon TOC's `## Version`, which the adapter stamps as `addon_version` (§6.3, §8.2). */
    version: string;
    /** Of the zip that `GET /api/v1/kits/{kit}/adapter` serves. */
    sha256: string;
  } | null;
}

export interface BridgeApiOptions {
  /** `PUBLIC_BASE_URL`. The resource is `<it>/api/v1`. */
  publicBaseUrl: string;
  /** The OAuth server, which holds the access tokens. */
  provider: Provider;
  pool: Pool;
  kits: KitRegistry;
  /** The ingest limits. Default: `DEFAULT_INGEST`. */
  ingest?: IngestSettings;
  /** The ingest endpoint's log (`IngestOptions.log`). */
  ingestLog?: (line: string) => void;
  /** Where each ingest request's events row goes (`IngestOptions.events`). */
  events?: EventRecorder;
}

export function bridgeApiRouter({ publicBaseUrl, provider, pool, kits, ingest = DEFAULT_INGEST, ingestLog, events }: BridgeApiOptions): Router {
  const router = express.Router();
  const requireIngest = requireToken({ provider, resource: resourcesOf(new URL(publicBaseUrl).origin).bridge, scope: "ingest" });
  const noStore: RequestHandler = (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  };

  router.get("/api/v1/kits", noStore, requireIngest, async (_req, res) => {
    const { rows } = await pool.query<{ kit: string }>(
      "select g.kit from user_games g join users u on u.id = g.user_id where u.uuid = $1",
      [currentToken(res)?.userUuid],
    );
    const enabled = new Set(rows.map((row) => row.kit));
    const list: KitList = {
      kits: kits
        .list()
        .filter((kit) => enabled.has(kit.key))
        .map((kit) => ({
          kit: kit.key,
          name: kit.name,
          manifest_version: kit.manifest.version,
          adapter: kit.adapter === null ? null : { version: kit.adapter.version, sha256: kit.adapter.sha256 },
        })),
    };
    res.json(list);
  });

  /** The registered kit the path names, or a 404 `unknown_kit`. */
  function withKit(send: (kit: Kit, res: Response) => void): RequestHandler<{ kit: string }> {
    return (req, res) => {
      const kit = kits.get(req.params.kit);
      if (kit === undefined) {
        res.status(404).json({ error: "unknown_kit" });
        return;
      }
      send(kit, res);
    };
  }

  router.get(
    "/api/v1/kits/:kit/manifest",
    noStore,
    requireIngest,
    withKit((kit, res) => {
      res.json(kit.manifest);
    }),
  );

  router.get(
    "/api/v1/kits/:kit/adapter",
    noStore,
    requireIngest,
    withKit((kit, res) => {
      if (kit.adapter === null) {
        res.status(404).json({ error: "no_adapter" });
        return;
      }
      res.set(ADAPTER_SHA256_HEADER, kit.adapter.sha256).type("application/zip").send(kit.adapter.data);
    }),
  );

  router.post("/api/v1/ingest", noStore, requireIngest, ingestHandler({ pool, kits, settings: ingest, log: ingestLog, events }));

  return router;
}
