// The re-parse command (§11): re-runs the current kit interpreters over the
// stored uploads of `DATABASE_URL`, and stores the results as ingest would.
// See `reparse-uploads.ts` for what it writes.
//
//   pnpm --filter @ogmcp/platform reparse [options]
//   node platform/dist/reparse.js [options]
//
//   --kit <key>               only this kit's uploads; may repeat
//   --status <status>         only uploads with this parse status: parsed,
//                             failed, or rejected; may repeat
//   --received-since <time>   only uploads received at or after this time
//   --received-before <time>  only uploads received before this time
//   --allow-regressions       also store regressions: parsed uploads that now
//                             fail or are rejected lose their snapshots
//   --dry-run                 re-parse and roll back: count what a run would
//                             do, and write nothing
//
// A time is a date (2026-09-24, UTC midnight) or an RFC 3339 time
// (2026-09-24T18:02:11Z). Without options it re-parses every upload of every
// kit in the registry. Without --allow-regressions, a parsed upload whose
// new parse fails or is rejected is left as it is and counted as regressed.
//
// It writes to the database. It is not part of the deploy: an operator runs
// it by hand after a build, and against production only with the owner's
// go-ahead. It is safe to run twice.
//
// Exit 0 when every selected upload was re-parsed; 1 when one was not, or the
// database could not be reached; 2 on a bad argument or configuration.
//
// The output never holds the URL, a Postgres message, or upload content. An
// upload that was not re-parsed is reported with its uuid and an error code.
// An upload newly rejected as "unknown" gets ingest's JSON log line (§6.3.1).
import { parseArgs } from "node:util";

import { type Config, loadConfig } from "./config.js";
import { createPool, failureCode } from "./db.js";
import { type KitRegistry, loadKitRegistry } from "./kits/registry.js";
import { PARSE_STATUSES, type ParseStatus, reparseUploads, type UploadSelection } from "./reparse-uploads.js";

const USAGE =
  "usage: reparse [--kit <key>]... [--status parsed|failed|rejected]... [--received-since <time>] [--received-before <time>] [--allow-regressions] [--dry-run]";

/** A date, or an RFC 3339 time. */
const TIME = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/;

function usageError(message: string): never {
  console.error(`reparse: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

function time(name: string, value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (!TIME.test(value) || Number.isNaN(date.getTime())) usageError(`--${name} must be a date or an RFC 3339 time, such as 2026-09-24`);
  return date;
}

function readArgs() {
  try {
    return parseArgs({
      options: {
        kit: { type: "string", multiple: true },
        status: { type: "string", multiple: true },
        "received-since": { type: "string" },
        "received-before": { type: "string" },
        "allow-regressions": { type: "boolean" },
        "dry-run": { type: "boolean" },
      },
    }).values;
  } catch (err) {
    return usageError((err as Error).message);
  }
}

const values = readArgs();
const selection: UploadSelection = {};
if (values.kit !== undefined) selection.kits = values.kit;
if (values.status !== undefined) {
  selection.statuses = values.status.map((status) => {
    if (!(PARSE_STATUSES as readonly string[]).includes(status)) usageError(`--status must be one of ${PARSE_STATUSES.join(", ")}`);
    return status as ParseStatus;
  });
}
const receivedSince = time("received-since", values["received-since"]);
if (receivedSince !== undefined) selection.receivedSince = receivedSince;
const receivedBefore = time("received-before", values["received-before"]);
if (receivedBefore !== undefined) selection.receivedBefore = receivedBefore;

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(`reparse: configuration error: ${(err as Error).message}`);
  process.exit(2);
}
let kits: KitRegistry;
try {
  kits = loadKitRegistry();
} catch (err) {
  console.error(`reparse: kit error: ${(err as Error).message}`);
  process.exit(2);
}
const unknownKit = selection.kits?.find((key) => kits.get(key) === undefined);
if (unknownKit !== undefined) usageError(`no kit "${unknownKit}"; the kits are ${kits.list().map((kit) => kit.key).join(", ")}`);

const pool = createPool({
  url: config.databaseUrl,
  queryTimeoutMs: config.databaseQueryTimeoutMs,
  max: 1,
  log: (line) => console.error(`reparse: ${line}`),
});
try {
  const dryRun = values["dry-run"] === true;
  const used = (selection.kits ?? kits.list().map((kit) => kit.key)).map((key) => `${key} ${kits.get(key)?.manifest.version}`);
  console.log(`reparse: kits ${used.join(", ")}${dryRun ? " (dry run: nothing is written)" : ""}`);
  const counts = await reparseUploads({
    pool,
    kits,
    maxBytes: config.ingest.maxBytes,
    selection,
    allowRegressions: values["allow-regressions"] === true,
    dryRun,
  });
  for (const [outcome, count] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`reparse: ${outcome} ${count}`);
  }
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  console.log(`reparse: ${total} upload(s) selected`);
  if ((counts["error"] ?? 0) > 0) process.exitCode = 1;
} catch (err) {
  console.error(`reparse: failed: code=${failureCode(err)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
