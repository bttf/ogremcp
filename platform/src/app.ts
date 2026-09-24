import express, { type ErrorRequestHandler, type Express } from "express";
import type Provider from "oidc-provider";

import { apiRouter } from "./api.js";
import { type AuthOptions, authRouter } from "./auth.js";
import { failureCode } from "./db.js";
import { type HealthOptions, healthRouter } from "./health.js";
import type { KitRegistry } from "./kits/registry.js";
import { mcpRouter } from "./mcp.js";
import { mountOidc } from "./oidc.js";
import { securityHeaders } from "./security-headers.js";
import { webFiles, webPages } from "./web.js";

export interface AppOptions {
  health: HealthOptions;
  /** Sign-in and web sessions. Left out by tests of the health endpoints alone. */
  auth?: AuthOptions;
  /**
   * The OAuth server (§9), from `createOidcProvider`. Needs `auth`: its
   * interactions read the web session. With it, `/mcp` and its resource
   * metadata are served; without it, neither is.
   */
  oidc?: Provider;
  /** Where the web UI's build is (`platform/dist/web`). Left out, no web UI is served. */
  webRoot?: string;
  /** The first-class kits, for the Games API of `auth`'s web UI. Left out, that API is not served. */
  kits?: KitRegistry;
  /** Whether `PUBLIC_BASE_URL` is https. Every response then carries HSTS. Default false. */
  https?: boolean;
  /**
   * `TRUST_PROXY_HOPS`. Railway's edge terminates TLS and adds
   * `X-Forwarded-For` and `X-Forwarded-Proto`; trusting that one hop makes
   * `req.ip` and `req.protocol` the client's. Default 0: no proxy trusted.
   */
  trustProxyHops?: number;
  /** Receives one line per request that failed with an error. Default: `console.error`. */
  log?: (line: string) => void;
}

/** The Express app. `index.ts` gives it the database and serves it. */
export function createApp({ health, auth, oidc, webRoot, kits, https = false, trustProxyHops = 0, log = console.error }: AppOptions): Express {
  if (oidc !== undefined && auth === undefined) throw new Error("the OAuth server needs the web sessions of `auth`");
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", trustProxyHops);
  app.use(securityHeaders({ https }));
  // Before the web session lookup, so that /health/live never reaches it.
  app.use(healthRouter(health));
  // Also before the web session lookup: `/mcp` and its metadata never read a web session.
  if (auth !== undefined && oidc !== undefined) app.use(mcpRouter({ publicBaseUrl: auth.publicBaseUrl, issuer: oidc.issuer }));
  if (webRoot !== undefined) app.use(webFiles(webRoot));
  if (auth !== undefined) {
    app.use(auth.sessions.middleware());
    if (oidc !== undefined) mountOidc(app, oidc, auth.pool);
    app.use(authRouter(auth));
    app.use(apiRouter({ ...auth, kits }));
  }
  // Last: it answers page loads that no route above took.
  if (webRoot !== undefined) app.use(webPages(webRoot));
  app.use(errorHandler(log));
  return app;
}

/**
 * Answers a request that failed with a plain 500, or with the 4xx status the
 * error carries. The log line holds a code only (`failureCode`): a Postgres
 * message can repeat a row. Express's own handler would log the message and,
 * outside production, send the stack.
 */
function errorHandler(log: (line: string) => void): ErrorRequestHandler {
  return (err: unknown, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = (err as { status?: unknown } | null)?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      res.status(status).type("text/plain").send("Bad request.");
      return;
    }
    log(`request failed: ${req.method} ${req.path} code=${failureCode(err)}`);
    res.status(500).type("text/plain").send("Something went wrong. Try again.");
  };
}
