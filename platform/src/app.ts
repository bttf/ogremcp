import express, { type ErrorRequestHandler, type Express } from "express";

import { type AuthOptions, authRouter } from "./auth.js";
import { failureCode } from "./db.js";
import { type HealthOptions, healthRouter } from "./health.js";

export interface AppOptions {
  health: HealthOptions;
  /** Sign-in and web sessions. Left out by tests of the health endpoints alone. */
  auth?: AuthOptions;
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
export function createApp({ health, auth, trustProxyHops = 0, log = console.error }: AppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", trustProxyHops);
  // First, so that /health/live never reaches the web session lookup.
  app.use(healthRouter(health));
  if (auth !== undefined) {
    app.use(auth.sessions.middleware());
    app.use(authRouter(auth));
  }
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
