import type { Pool } from "pg";

import { failureCode } from "./db.js";
import { decompress, parseUpload, writeSnapshot } from "./ingest.js";
import type { KitRegistry } from "./kits/registry.js";

/**
 * Re-parses stored uploads with the current interpreters (§11): the uploads
 * table keeps every upload's gzipped bytes, so an interpreter fix reaches old
 * uploads. `reparse.ts` is the command.
 *
 * Each selected upload goes through ingest's own steps (`ingest.ts`): the
 * bytes are decompressed within the ingest cap, the kit's interpreter parses
 * them, and the flavor is checked against the kit manifest. The parse's
 * reference time (`ParseOptions.now`) is the upload's `received_at`, so the
 * result does not depend on the day the command runs. Then, as ingest would
 * have stored it:
 *
 * - The upload's `kit_version` (the manifest's `version` that parsed it),
 *   `adapter_schema`, `parse_status`, `parse_error`, and `flavor` are set to
 *   the new result.
 * - A `parsed` upload gets its snapshot, or its snapshot is replaced in place
 *   and keeps its uuid. A `failed` or `rejected` upload loses its snapshot.
 *
 * A column or snapshot that already holds the new value is not written, so a
 * second run over the same uploads with the same kits changes nothing.
 *
 * Each upload is re-parsed in its own transaction, which locks its row. An
 * upload that fails (bytes over the cap or not gzip, a kit bug, a database
 * error) is rolled back and reported, and the run goes on. Only one upload's
 * bytes are in memory at a time: the selection is read in pages of ids.
 */

/** `uploads.parse_status` (§11). */
export const PARSE_STATUSES = ["parsed", "failed", "rejected"] as const;
export type ParseStatus = (typeof PARSE_STATUSES)[number];

/** Which uploads to re-parse. Every criterion given must hold. */
export interface UploadSelection {
  /** Kit keys, each in the registry. Default: every kit in the registry. An upload of another kit is never selected. */
  kits?: readonly string[];
  /** Default: every status. */
  statuses?: readonly ParseStatus[];
  /** Uploads received at or after this time. */
  receivedSince?: Date;
  /** Uploads received before this time. */
  receivedBefore?: Date;
}

export interface ReparseOptions {
  pool: Pool;
  kits: KitRegistry;
  /** The cap on an upload's uncompressed bytes (§8.3): `IngestSettings.maxBytes`. */
  maxBytes: number;
  selection: UploadSelection;
  /** Upload ids read per query. Default 100. */
  pageSize?: number;
  /** Receives one line per upload that could not be re-parsed. Default: `console.error`. */
  log?: (line: string) => void;
}

/**
 * Counts per outcome. `unchanged`: nothing was written. `<before> -> <after>`,
 * e.g. `failed -> parsed`: the parse statuses of an upload that changed.
 * `error`: rolled back and logged. `gone`: deleted since it was selected.
 */
export type ReparseCounts = Record<string, number>;

/** The selected uploads, counted by kit and parse status, in that order. Reads no bytes. */
export async function countUploads(
  pool: Pool,
  kits: KitRegistry,
  selection: UploadSelection,
): Promise<{ kit: string; status: string; count: number }[]> {
  const { rows } = await pool.query<{ kit: string; parse_status: string; count: string }>(
    `select kit, parse_status, count(*) as count from uploads where ${SELECTED} group by kit, parse_status order by kit, parse_status`,
    selectionParams(kits, selection),
  );
  return rows.map((row) => ({ kit: row.kit, status: row.parse_status, count: Number(row.count) }));
}

/** Re-parses the selected uploads that were received before the call, in id order. */
export async function reparseUploads({
  pool,
  kits,
  maxBytes,
  selection,
  pageSize = 100,
  log = console.error,
}: ReparseOptions): Promise<ReparseCounts> {
  const params = selectionParams(kits, selection);
  const counts: ReparseCounts = {};
  // Uploads that arrive during the run were parsed by the same code at ingest.
  const { rows: top } = await pool.query<{ id: string | null }>("select max(id) as id from uploads");
  const lastId = top[0]?.id ?? null;
  if (lastId === null) return counts;

  let afterId = "0";
  for (;;) {
    const page = await pool.query<{ id: string; uuid: string }>(
      `select id, uuid from uploads where ${SELECTED} and id > $5 and id <= $6 order by id limit $7`,
      [...params, afterId, lastId, pageSize],
    );
    for (const { id, uuid } of page.rows) {
      let outcome: string;
      try {
        outcome = await reparseUpload(pool, kits, maxBytes, id);
      } catch (err) {
        log(`reparse: upload ${uuid} not re-parsed: code=${failureCode(err)}`);
        outcome = "error";
      }
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
    const last = page.rows.at(-1);
    if (last === undefined || page.rows.length < pageSize) return counts;
    afterId = last.id;
  }
}

/** The selection's `where` clause, over `selectionParams`' $1 to $4. */
const SELECTED = `kit = any($1::text[])
  and ($2::text[] is null or parse_status = any($2::text[]))
  and ($3::timestamptz is null or received_at >= $3::timestamptz)
  and ($4::timestamptz is null or received_at < $4::timestamptz)`;

function selectionParams(kits: KitRegistry, selection: UploadSelection): unknown[] {
  const keys = selection.kits ?? kits.list().map((kit) => kit.key);
  const unknown = keys.find((key) => kits.get(key) === undefined);
  if (unknown !== undefined) throw new Error(`no kit "${unknown}" in the registry`);
  return [keys, selection.statuses ?? null, selection.receivedSince ?? null, selection.receivedBefore ?? null];
}

/** Re-parses one upload in its own transaction, and answers its outcome (`ReparseCounts`). */
async function reparseUpload(pool: Pool, kits: KitRegistry, maxBytes: number, id: string): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{
      kit: string;
      source_id: string;
      content_gzip: Buffer;
      parse_status: ParseStatus;
      received_at: Date;
    }>("select kit, source_id, content_gzip, parse_status, received_at from uploads where id = $1 for update", [id]);
    const row = rows[0];
    if (row === undefined) {
      await client.query("rollback");
      return "gone";
    }
    const kit = kits.get(row.kit);
    if (kit === undefined) throw new Error("the upload's kit is not in the registry");

    const bytes = await decompress(row.content_gzip, maxBytes);
    const result = parseUpload(kit, row.source_id, bytes, row.received_at);

    const upload = await client.query(
      `update uploads
          set kit_version = $2, adapter_schema = $3, parse_status = $4, parse_error = $5, flavor = $6
        where id = $1
          and (kit_version, adapter_schema, parse_status, parse_error, flavor)
              is distinct from ($2::text, $3::integer, $4::text, $5::text, $6::text)`,
      [id, kit.manifest.version, result.parsed?.adapterSchema ?? null, result.status, result.parseError, result.rejectedFlavor],
    );
    const snapshotChanged =
      result.status === "parsed"
        ? (await writeSnapshot(client, id, result.parsed)) !== null
        : ((await client.query("delete from snapshots where upload_id = $1", [id])).rowCount ?? 0) > 0;
    await client.query("commit");
    return (upload.rowCount ?? 0) > 0 || snapshotChanged ? `${row.parse_status} -> ${result.status}` : "unchanged";
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
