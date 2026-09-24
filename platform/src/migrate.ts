// The migrate command (§11, §13.1): applies the pending files of
// `platform/migrations/` to the database of `DATABASE_URL`. See
// `migrations.ts` for what the runner does.
//
//   pnpm --filter @ogmcp/platform migrate [--dry-run]
//   node platform/dist/migrate.js [--dry-run]
//
// Railway runs the second form as the `ogmcp` service's pre-deploy command,
// so a deploy migrates before the new version starts, and a failed migrate
// stops the deploy. Self-host runs it at container start (§13.3). With
// `--dry-run` it lists the pending files and applies nothing.
//
// Exit 0 when nothing is pending or everything was applied; 1 when a file
// failed or the database could not be reached; 2 on a bad argument or
// configuration.
//
// The output never holds the URL or a Postgres message, which can repeat a
// row. A failed file is reported with its name and SQLSTATE; run it under
// psql against a local database to see the full error.
import { type Config, loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { MigrationFailure, migrate, migrationStatus } from "./migrations.js";

/**
 * Most time one migration file, or the wait for another migrate's lock, may
 * take. Longer than the service's query timeout: a migration can rewrite a
 * large table. A file that needs more is split or raises this.
 */
const MIGRATE_QUERY_TIMEOUT_MS = 10 * 60_000;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
if (args.some((arg) => arg !== "--dry-run")) {
  console.error("usage: migrate [--dry-run]");
  process.exit(2);
}

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(`migrate: configuration error: ${(err as Error).message}`);
  process.exit(2);
}

const pool = createPool({
  url: config.databaseUrl,
  queryTimeoutMs: MIGRATE_QUERY_TIMEOUT_MS,
  max: 1,
  log: (line) => console.error(`migrate: ${line}`),
});
try {
  if (dryRun) {
    const status = await migrationStatus(pool);
    if (!status.tracked) console.log("migrate: schema_migrations does not exist yet; every file is pending");
    for (const file of status.pending) console.log(`migrate: pending ${file.name}`);
    console.log(`migrate: dry run, ${status.pending.length} file(s) would be applied`);
  } else {
    const applied = await migrate(pool, { log: (line) => console.log(`migrate: ${line}`) });
    console.log(applied.length === 0 ? "migrate: nothing to apply" : `migrate: applied ${applied.length} file(s)`);
  }
} catch (err) {
  if (err instanceof MigrationFailure) {
    console.error(`migrate: ${err.message}; the files before it stay applied`);
  } else {
    console.error(`migrate: ${err instanceof Error ? err.message : "failed"}`);
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}
