// The platform service: web UI, MCP server, bridge API, and OAuth server
// (docs/architecture.md §5, §13). For now it serves the health endpoints,
// Google and Discord sign-in with web sessions (§13.1), the web UI shell with
// its Sign in and Games pages (§13.2), and the OAuth server with the MCP
// endpoint's discovery (§9).
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "./app.js";
import { type Config, loadConfig } from "./config.js";
import { createPool, failureCode } from "./db.js";
import { type KitRegistry, loadKitRegistry } from "./kits/registry.js";
import { applyServerLimits, startServer } from "./listen.js";
import { createOidcProvider } from "./oidc.js";
import { type OidcKeys, resolveOidcKeys } from "./oidc-keys.js";
import { startClientCleanup } from "./oidc-registration.js";
import { createSignInProviders } from "./sign-in-providers.js";
import { WebSessions } from "./web-sessions.js";

// A missing or malformed DATABASE_URL, or another bad value, ends the process
// before it listens. No message repeats the URL or a client secret.
let config: Config;
let oidcKeys: OidcKeys;
try {
  config = loadConfig(process.env);
  // Without OIDC_JWKS and OIDC_COOKIE_KEYS, only a local run starts, on keys
  // made now. No message repeats a key.
  const resolved = resolveOidcKeys(config.oidcKeys, config.publicBaseUrl, config.production);
  oidcKeys = resolved.keys;
  if (resolved.ephemeral) {
    console.warn(
      "OIDC_JWKS and OIDC_COOKIE_KEYS are not set: the OAuth server uses keys made at start, so its tokens and cookies stop working when the process restarts",
    );
  }
} catch (err) {
  console.error(`configuration error: ${(err as Error).message}`);
  process.exit(1);
}

// A kit whose manifest, tool names, or adapter zip is bad ends the process
// before it listens (§5, §6.1). The Games API lists them (§13.2). RED-312
// serves them to the bridge.
let kits: KitRegistry;
try {
  kits = loadKitRegistry();
} catch (err) {
  console.error(`kit error: ${(err as Error).message}`);
  process.exit(1);
}
console.log(`kits: ${kits.list().map((kit) => `${kit.key} ${kit.manifest.version}`).join(", ")}`);

// The build writes the web UI to `platform/dist/web` (§13.2). Without it the
// service would answer every page load with a 404, so it does not start.
const webRoot = fileURLToPath(new URL("./web", import.meta.url));
if (!existsSync(join(webRoot, "index.html"))) {
  console.error(`web UI error: ${join(webRoot, "index.html")} is missing. Run the platform build.`);
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
  console.error(`database is not reachable: code=${failureCode(err)}`);
  process.exit(1);
}
console.log(
  tls
    ? "database connection uses TLS"
    : "database connection does not use TLS: a database reached over the internet needs sslmode=verify-full in DATABASE_URL",
);

// Sign-in providers without credentials stay off, and their routes answer 503.
const providers = createSignInProviders(config);
const signIn = (["google", "discord"] as const).filter((name) => providers[name] !== null);
console.log(
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
  });
} catch (err) {
  console.error(`configuration error: ${(err as Error).message}`);
  process.exit(1);
}

// Deletes the OAuth clients registered by DCR that have gone unused (§9),
// now and once a day.
startClientCleanup({ pool, unusedClientDays: config.registration.unusedClientDays });

const app = createApp({
  health: { checkDatabase: () => pool.query("select 1") },
  auth: { pool, sessions, providers, publicBaseUrl: config.publicBaseUrl },
  oidc,
  mcpAllowedOrigins: config.mcpAllowedOrigins,
  webRoot,
  kits,
  https,
  trustProxyHops: config.trustProxyHops,
});

// The start line and the failed bind are `listen.ts`, which is tested on its own.
startServer(applyServerLimits(createServer(app)), config.port);
