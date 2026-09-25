import express, { type ErrorRequestHandler, type Express } from "express";
import type Provider from "oidc-provider";

import { apiRouter } from "./api.js";
import { type AuthOptions, authRouter } from "./auth.js";
import { bridgeApiRouter } from "./bridge-api.js";
import { failureCode } from "./db.js";
import type { EventRecorder } from "./events.js";
import { type HealthOptions, healthRouter } from "./health.js";
import type { IngestSettings } from "./ingest.js";
import type { KitRegistry } from "./kits/registry.js";
import { logger, requestLog } from "./log.js";
import { mcpRouter } from "./mcp.js";
import { mountOidc } from "./oidc.js";
import type { PageFetch } from "./pages.js";
import type { ScopedSearch } from "./search.js";
import { securityHeaders } from "./security-headers.js";
import type { ToolContextSettings } from "./tool-context.js";
import { createToolRegistry } from "./tools.js";
import { webFiles, webPages } from "./web.js";

export interface AppOptions {
  health: HealthOptions;
  /** Sign-in and web sessions. Left out by tests of the health endpoints alone. */
  auth?: AuthOptions;
  /**
   * The OAuth server (§9), from `createOidcProvider`. Needs `auth`: its
   * interactions read the web session. With it, `/mcp`, its resource
   * metadata, and the web UI's Connected agents API are served; without it,
   * none is.
   */
  oidc?: Provider;
  /** `MCP_ALLOWED_ORIGINS`: the `Origin` values `/mcp` accepts. Default: `defaultMcpAllowedOrigins`. */
  mcpAllowedOrigins?: readonly string[];
  /** Where the web UI's build is (`platform/dist/web`). Left out, no web UI is served. */
  webRoot?: string;
  /**
   * The first-class kits, for the Games API of `auth`'s web UI and, with
   * `oidc`, the bridge's kit endpoints (§8.2) and the kit tools on `/mcp`
   * (§10). Left out, the Games API and the bridge's kit endpoints are not
   * served, and `/mcp` lists no kit tool.
   */
  kits?: KitRegistry;
  /**
   * The tool call limits (`HISTORY_MAX_SNAPSHOTS`, `TOOL_RESULT_MAX_BYTES`, `LIST_GAMES_CHARACTERS`,
   * `FETCH_PAGE_MAX_CHARS`, `REPORT_ISSUE_MAX_PER_DAY`, `REPORT_ISSUE_CALLS`). Default: `DEFAULT_TOOL_CONTEXT`.
   */
  toolContext?: ToolContextSettings;
  /** Game-scoped search for `search_game_info` (§12), or null without `FIRECRAWL_API_KEY`. Default: null. */
  search?: ScopedSearch | null;
  /** Page fetches for `fetch_game_page` (§12), or null without `FIRECRAWL_API_KEY`. Default: null. */
  fetchPage?: PageFetch | null;
  /** `BRIDGE_DOWNLOAD_URL`, for `auth`'s web UI (§13.2). Default: none. */
  bridgeDownloadUrl?: string | null;
  /** The `INGEST_` names: the ingest endpoint's limits (§8.3). Default: `DEFAULT_INGEST`. */
  ingest?: IngestSettings;
  /** The ingest endpoint's log (`IngestOptions.log`). */
  ingestLog?: (line: string) => void;
  /**
   * Where the events rows of tool calls and ingest requests go (§16): one
   * recorder, so that its bound on pending inserts covers both. `index.ts`
   * gives it a pool of its own. Default: none, and nothing is recorded.
   */
  events?: EventRecorder;
  /** Whether `PUBLIC_BASE_URL` is https. Every response then carries HSTS. Default false. */
  https?: boolean;
  /**
   * `TRUST_PROXY_HOPS`. Railway's edge terminates TLS and adds
   * `X-Forwarded-For` and `X-Forwarded-Proto`; trusting that one hop makes
   * `req.ip` and `req.protocol` the client's. Default 0: no proxy trusted.
   */
  trustProxyHops?: number;
  /** Receives one line per request that failed with an error. Default: `logger.error`. */
  log?: (line: string) => void;
}

/** The Express app. `index.ts` gives it the database and serves it. */
export function createApp({
  health,
  auth,
  oidc,
  mcpAllowedOrigins,
  webRoot,
  kits,
  toolContext,
  search,
  fetchPage,
  bridgeDownloadUrl,
  ingest,
  ingestLog,
  events,
  https = false,
  trustProxyHops = 0,
  log = logger.error,
}: AppOptions): Express {
  if (oidc !== undefined && auth === undefined) throw new Error("the OAuth server needs the web sessions of `auth`");
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", trustProxyHops);
  // First, so that every response has a request ID and an access line (§16).
  app.use(requestLog({ trustEdgeRequestId: trustProxyHops > 0 }));
  app.use(securityHeaders({ https }));
  // Before the web session lookup, so that /health/live never reaches it.
  app.use(healthRouter(health));
  // Also before the web session lookup: `/mcp` and its metadata never read a web session.
  if (auth !== undefined && oidc !== undefined) {
    // The registry checks the platform tools' names: a bad one stops the start (§10.1).
    const tools = createToolRegistry({ pool: auth.pool, kits, settings: toolContext, search, fetchPage, log, events });
    app.use(mcpRouter({ publicBaseUrl: auth.publicBaseUrl, provider: oidc, allowedOrigins: mcpAllowedOrigins, tools, log }));
    // The bridge's routes take an access token, not a web session (§8.1).
    if (kits !== undefined) {
      app.use(bridgeApiRouter({ publicBaseUrl: auth.publicBaseUrl, provider: oidc, pool: auth.pool, kits, ingest, ingestLog, events }));
    }
  }
  if (webRoot !== undefined) app.use(webFiles(webRoot));
  if (auth !== undefined) {
    app.use(auth.sessions.middleware());
    if (oidc !== undefined) mountOidc(app, oidc, auth.pool);
    app.use(authRouter(auth));
    app.use(apiRouter({ ...auth, kits, oidc, bridgeDownloadUrl }));
  }
  // Last: it answers page loads that no route above took.
  if (webRoot !== undefined) app.use(webPages(webRoot));
  app.use(errorHandler(log));
  return app;
}

/**
 * Answers a request that failed with a plain 500, or with the 4xx status the
 * error carries. The log line holds a code only (`failureCode`): a Postgres
 * message can repeat a row. Its route and request ID come from the request's
 * context (`log.ts`), not the path, which can hold IDs. Express's own handler
 * would log the message and, outside production, send the stack.
 */
function errorHandler(log: (line: string) => void): ErrorRequestHandler {
  return (err: unknown, _req, res, next) => {
    if (res.headersSent) return next(err);
    const status = (err as { status?: unknown } | null)?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      res.status(status).type("text/plain").send("Bad request.");
      return;
    }
    log(`request failed: code=${failureCode(err)}`);
    res.status(500).type("text/plain").send("Something went wrong. Try again.");
  };
}
