import express, { type Request, type Response, type Router } from "express";

import { setRoute } from "./log.js";

/**
 * Paths the service owns. A page load of one, or of a path under one, never
 * gets the web app: it goes on to the route that owns it, or to the 404.
 * `/device` is not one: a page load of it is the web app's Device approval
 * page, and `mountOidc` takes the page's calls and `/device/:uid` first.
 */
const SERVICE_PATHS = ["/api", "/auth", "/health", "/mcp", "/oauth", "/.well-known"];

function isServicePath(path: string): boolean {
  return SERVICE_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Headers on every file of the web app, on top of `securityHeaders`. The
 * build emits no inline script or style, so the policy allows this origin's
 * files only. `Referrer-Policy: same-origin` keeps the `Origin` header on the
 * sign-out form's POST, which `requireSameOrigin` needs; `no-referrer` would
 * send `Origin: null`.
 */
export const WEB_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/**
 * True for a page load. A browser names `text/html` first when it navigates,
 * and sends a wildcard for a script, an image, or a `fetch`. `json` is listed
 * first, so a wildcard or no `Accept` header does not get the page.
 */
function wantsHtml(req: Request): boolean {
  return req.accepts(["json", "html"]) === "html";
}

/**
 * The web UI (§13.2) is the Vite build of `platform/web`, in `root`. Two
 * handlers serve it:
 *
 * - `webFiles`: its files by path. Mount it before the web session
 *   middleware: no file depends on who is signed in. Vite names each file
 *   under `assets/` by its content hash, so those are cached for a year.
 * - `webPages`: `index.html` for every other page load, because the
 *   client-side router owns those paths. Mount it after every other route: a
 *   request it does not answer goes on to the 404.
 *
 * `index.html` is revalidated on every load, so a deploy takes effect on the
 * next one. A page load's answer is also `private`: the web session
 * middleware can add a renewed cookie to it, which no shared cache may keep.
 *
 * Their log lines name no path, which can hold an ID such as `/consent/:uid`'s:
 * the route is `(web file)` or `(web page)`.
 *
 * Adapted from `cloud/src/web.ts` in bttf/wow-guide@df80260.
 */
export function webFiles(root: string): Router {
  const router = express.Router();
  router.use(
    express.static(root, {
      index: false,
      setHeaders: (res: Response, path: string) => {
        setRoute("(web file)");
        res.set(WEB_HEADERS);
        const hashed = /[\\/]assets[\\/][^\\/]+$/.test(path);
        res.set("Cache-Control", hashed ? "public, max-age=31536000, immutable" : "no-cache");
      },
    }),
  );
  return router;
}

export function webPages(root: string): Router {
  const router = express.Router();
  router.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (isServicePath(req.path) || !wantsHtml(req)) return next();
    setRoute("(web page)");
    res.set(WEB_HEADERS);
    res.set("Cache-Control", "private, no-cache");
    res.sendFile("index.html", { root }, (err) => {
      if (err) next(err);
    });
  });
  return router;
}
