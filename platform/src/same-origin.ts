import type { RequestHandler } from "express";

/**
 * CSRF protection for the web UI's state-changing requests, which the web
 * session cookie authenticates. The request's `Origin` must be the service's
 * own. Browsers send `Origin` on every POST, so a request without one, or
 * with `null`, is refused too.
 *
 * Mount it on web UI routes only. `/mcp` and the OAuth endpoints take
 * requests from other origins and have checks of their own (§9).
 */
export function requireSameOrigin(publicBaseUrl: string): RequestHandler {
  const expected = new URL(publicBaseUrl).origin;
  return (req, res, next) => {
    if (req.headers.origin === expected) return next();
    res.status(403).type("text/plain").send("Refused: this request did not come from this site.");
  };
}
