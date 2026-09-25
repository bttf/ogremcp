// The platform service: web UI, MCP server, bridge API, and OAuth server
// (docs/architecture.md §5, §13). For now it serves the health endpoints,
// Google and Discord sign-in with web sessions (§13.1), the web UI shell with
// its Sign in and Games pages (§13.2), the OAuth server with the MCP
// endpoint's discovery (§9), the kit tools of each user's enabled games (§10)
// and search_game_info and fetch_game_page (§12), the bridge's device flow
// (§8.1), the bridge's kit and ingest endpoints (§8.2, §8.3), and the §16.1
// metrics of the Admin page (§13.2).
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAdminPool } from "./admin.js";
import { createApp } from "./app.js";
import { type Config, loadConfig } from "./config.js";
import { createPool, failureCode } from "./db.js";
import { createEventRecorder, createEventsPool } from "./events.js";
import { type KitRegistry, loadKitRegistry } from "./kits/registry.js";
import { applyServerLimits, startServer } from "./listen.js";
import { captureConsole, configureLogger, logger } from "./log.js";
import { createOidcProvider } from "./oidc.js";
import { type OidcKeys, resolveOidcKeys } from "./oidc-keys.js";
import { startClientCleanup } from "./oidc-registration.js";
import { firecrawlPageFetch } from "./pages.js";
import { startRetention } from "./retention.js";
import { firecrawlScopedSearch } from "./search.js";
import { cachedPageFetch, cachedSearch } from "./search-cache.js";
import { createSignInProviders } from "./sign-in-providers.js";
import { WebSessions } from "./web-sessions.js";

// Every line the process writes is JSON (§16), a library's `console` output
// too: oidc-provider prints its notices that way.
captureConsole();

// A missing or malformed DATABASE_URL, or another bad value, ends the process
// before it listens. No message repeats the URL or a client secret.
let config: Config;
let oidcKeys: OidcKeys;
try {
  config = loadConfig(process.env);
  configureLogger({ level: config.logLevel });
  // Without OIDC_JWKS and OIDC_COOKIE_KEYS, only a local run starts, on keys
  // made now. No message repeats a key.
  const resolved = resolveOidcKeys(config.oidcKeys, config.publicBaseUrl, config.production);
  oidcKeys = resolved.keys;
  if (resolved.ephemeral) {
    logger.warn(
      "OIDC_JWKS and OIDC_COOKIE_KEYS are not set: the OAuth server uses keys made at start, so its tokens and cookies stop working when the process restarts",
    );
  }
} catch (err) {
  logger.error(`configuration error: ${(err as Error).message}`);
  process.exit(1);
}

// A kit whose manifest, tool names, or adapter zip is bad ends the process
// before it listens (§5, §6.1). The Games API lists them (§13.2), and the
// bridge API serves their manifests and adapters (§8.2).
let kits: KitRegistry;
try {
  kits = loadKitRegistry();
} catch (err) {
  logger.error(`kit error: ${(err as Error).message}`);
  process.exit(1);
}
logger.info(`kits: ${kits.list().map((kit) => `${kit.key} ${kit.manifest.version}`).join(", ")}`);

// The build writes the web UI to `platform/dist/web` (§13.2). Without it the
// service would answer every page load with a 404, so it does not start.
const webRoot = fileURLToPath(new URL("./web", import.meta.url));
if (!existsSync(join(webRoot, "index.html"))) {
  logger.error(`web UI error: ${join(webRoot, "index.html")} is missing. Run the platform build.`);
  process.exit(1);
}

// The pool opens no connection until the first query. This query runs now, so
// a database that cannot be reached ends the process at start and fails the
// deploy, not the first request. The output is a code, never the URL.
const pool = createPool({ url: config.databaseUrl, queryTimeoutMs: config.databaseQueryTimeoutMs });
let tls: boolean;
try {
  const client = await pool.connect();
  try {
    await client.query("select 1");
    // pg asks for TLS when the URL's sslmode (or PGSSLMODE) says so, and a
    // connection that asked for it fails when the server has none. So a
    // connection that is up uses TLS exactly when it asked for it.
    tls = Boolean(client.ssl);
  } finally {
    client.release();
  }
} catch (err) {
  logger.error(`database is not reachable: code=${failureCode(err)}`);
  process.exit(1);
}
logger.info(
  tls
    ? "database connection uses TLS"
    : "database connection does not use TLS: a database reached over the internet needs sslmode=verify-full in DATABASE_URL",
);

// Sign-in providers without credentials stay off, and their routes answer 503.
const providers = createSignInProviders(config);
const signIn = (["google", "discord"] as const).filter((name) => providers[name] !== null);
logger.info(
  `public base URL ${config.publicBaseUrl}; sign-in providers: ${signIn.length === 0 ? "none (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or the DISCORD_ pair)" : signIn.join(", ")}`,
);

const https = new URL(config.publicBaseUrl).protocol === "https:";
const sessions = new WebSessions({
  pool,
  lifetimeMs: config.webSessionLifetimeMs,
  renewWithinMs: config.webSessionRenewWithinMs,
  secure: https,
});

// The issuer is PUBLIC_BASE_URL (§9). oidc-provider checks the keys here.
let oidc: ReturnType<typeof createOidcProvider>;
try {
  oidc = createOidcProvider({
    pool,
    issuer: config.publicBaseUrl,
    keys: oidcKeys,
    trustProxyHops: config.trustProxyHops,
    tokenLifetimes: config.tokenLifetimes,
    registration: config.registration,
    cimdFetchLimits: config.cimdFetchLimits,
    deviceCodeMisses: config.deviceCodeMisses,
  });
} catch (err) {
  logger.error(`configuration error: ${(err as Error).message}`);
  process.exit(1);
}

// Game-scoped search and page fetches (§12), through the shared cache. Without
// a key, search_game_info and fetch_game_page answer search_unavailable. No
// line repeats the key.
const { apiKey, timeoutMs } = config.firecrawl;
const cache = { pool, settings: config.searchCache };
const search = apiKey === null ? null : cachedSearch(firecrawlScopedSearch({ apiKey, timeoutMs }), cache);
const fetchPage = apiKey === null ? null : cachedPageFetch(firecrawlPageFetch({ apiKey, timeoutMs }), cache);
logger.info(`search: ${search === null ? "off (set FIRECRAWL_API_KEY)" : "Firecrawl, with the shared cache"}`);

// The events table (§16): one row per tool call and ingest request, written
// on a pool of its own, so that a slow or locked table never holds a
// connection a request needs.
const events = createEventRecorder({ pool: createEventsPool({ url: config.databaseUrl }) });

// The daily tool-call caps (§14). The calls are counted in usage_daily with
// or without them.
const caps = config.toolCallCaps;
logger.info(`tool calls per day: free ${caps.free ?? "no cap"}, paid ${caps.paid ?? "no cap"}`);

// Who may open /admin (§13.2). The line counts them and names none. Its
// queries run on a pool of their own, of one connection, which no request
// needs.
logger.info(`admin users: ${config.adminUserUuids.length}`);
const admin = { pool: createAdminPool({ url: config.databaseUrl }), adminUserUuids: config.adminUserUuids };

// Deletes the OAuth clients registered by DCR that have gone unused (§9),
// now and once a day.
startClientCleanup({ pool, unusedClientDays: config.registration.unusedClientDays });

// Deletes free users' expired uploads and snapshots (§11, §14), now and once
// a day. Paid users keep theirs. FREE_RETENTION_DAYS=off keeps everyone's.
const { freeRetentionDays, downgradeGraceDays } = config.retention;
logger.info(
  freeRetentionDays === null
    ? "history retention: off, every user keeps their history forever"
    : `history retention: free ${freeRetentionDays} days, or all of it for ${downgradeGraceDays} days after a downgrade; paid forever`,
);
startRetention({ pool, settings: config.retention });

const app = createApp({
  health: { checkDatabase: () => pool.query("select 1") },
  auth: { pool, sessions, providers, publicBaseUrl: config.publicBaseUrl },
  oidc,
  mcpAllowedOrigins: config.mcpAllowedOrigins,
  webRoot,
  kits,
  toolContext: config.toolContext,
  search,
  fetchPage,
  bridgeDownloadUrl: config.bridgeDownloadUrl,
  contactEmail: config.contactEmail,
  ingest: config.ingest,
  events,
  toolCallCaps: caps,
  admin,
  https,
  trustProxyHops: config.trustProxyHops,
});

// The start line and the failed bind are `listen.ts`, which is tested on its own.
startServer(applyServerLimits(createServer(app)), config.port);
