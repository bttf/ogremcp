// The platform service: web UI, MCP server, bridge API, and OAuth server
// (docs/architecture.md §5, §13). For now it serves the health endpoints and
// Google and Discord sign-in with web sessions (§13.1).
import { createServer } from "node:http";

import { createApp } from "./app.js";
import { type Config, loadConfig } from "./config.js";
import { createPool, failureCode } from "./db.js";
import { applyServerLimits, startServer } from "./listen.js";
import { createSignInProviders } from "./sign-in-providers.js";
import { WebSessions } from "./web-sessions.js";

// A missing or malformed DATABASE_URL, or another bad value, ends the process
// before it listens. No message repeats the URL or a client secret.
let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(`configuration error: ${(err as Error).message}`);
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

const sessions = new WebSessions({
  pool,
  lifetimeMs: config.webSessionLifetimeMs,
  renewWithinMs: config.webSessionRenewWithinMs,
  secure: new URL(config.publicBaseUrl).protocol === "https:",
});

const app = createApp({
  health: { checkDatabase: () => pool.query("select 1") },
  auth: { pool, sessions, providers, publicBaseUrl: config.publicBaseUrl },
  trustProxyHops: config.trustProxyHops,
});

// The start line and the failed bind are `listen.ts`, which is tested on its own.
startServer(applyServerLimits(createServer(app)), config.port);
