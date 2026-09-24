// The platform service: web UI, MCP server, bridge API, and OAuth server
// (docs/architecture.md §5, §13). For now it serves the health endpoints only.
import { createServer } from "node:http";

import { createApp } from "./app.js";
import { type Config, loadConfig } from "./config.js";
import { createPool, failureCode } from "./db.js";
import { type KitRegistry, loadKitRegistry } from "./kits/registry.js";
import { applyServerLimits, startServer } from "./listen.js";

// A missing or malformed DATABASE_URL ends the process before it listens.
// The message never repeats the URL.
let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(`configuration error: ${(err as Error).message}`);
  process.exit(1);
}

// A kit whose manifest, tool names, or adapter zip is bad ends the process
// before it listens (§5, §6.1). RED-312 serves the kits.
let kits: KitRegistry;
try {
  kits = loadKitRegistry();
} catch (err) {
  console.error(`kit error: ${(err as Error).message}`);
  process.exit(1);
}
console.log(`kits: ${kits.list().map((kit) => `${kit.key} ${kit.manifest.version}`).join(", ")}`);

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

const app = createApp({ checkDatabase: () => pool.query("select 1") });

// The start line and the failed bind are `listen.ts`, which is tested on its own.
startServer(applyServerLimits(createServer(app)), config.port);
