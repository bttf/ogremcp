import type { RequestHandler } from "express";

/** One year, in seconds. No `includeSubDomains` or `preload`: the default Railway domain is shared, and self-hosters pick their own. */
export const HSTS = "max-age=31536000";

/**
 * Headers on every response of the service. When `PUBLIC_BASE_URL` is https,
 * `Strict-Transport-Security` tells browsers to reach this host over https
 * only. Plain http on the local machine gets none: a browser would then
 * refuse `http://localhost` for a year.
 */
export function securityHeaders({ https }: { https: boolean }): RequestHandler {
  return (_req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    if (https) res.set("Strict-Transport-Security", HSTS);
    next();
  };
}
