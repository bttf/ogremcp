import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import { ParseError, type Parsed, type UnknownFlavor } from "@ogmcp/sdk";
import { Ajv2020 } from "ajv/dist/2020.js";
import busboy from "busboy";
import type { Request, RequestHandler, Response } from "express";
import type { Pool, PoolClient } from "pg";

import { UploadLimiter } from "./ingest-limit.js";
import type { Kit, KitRegistry } from "./kits/registry.js";
import { currentToken, type VerifiedToken } from "./oidc-tokens.js";

/**
 * `POST /api/v1/ingest` (§8.3): one upload of one source instance from a
 * bridge. `bridge-api.ts` mounts it behind `requireToken`, so the request
 * carries an `ingest` access token for the bridge API.
 *
 * The request is `multipart/form-data` with two parts: `meta`, a form field
 * that holds the §8.3 JSON, and `file`, a file part (one with a filename, or
 * of type `application/octet-stream`, as Go's `CreateFormFile` writes it)
 * that holds the source's raw bytes, gzip-compressed.
 *
 * 1. The token's grant names the device: the `devices` row with its
 *    `grant_id`, of the token's user (§8.1). No such row, or a revoked one,
 *    gets 401 with an RFC 6750 challenge and no body, as a bad token does.
 * 2. The parts are read with hard limits, so nothing large is buffered:
 *    `META_MAX_BYTES` for `meta`, `maxCompressedBytes` for `file`. Over
 *    either: 413 `too_large`. `meta` is checked as soon as it is read, and
 *    the upload is counted against the rate limits of its `(device, kit,
 *    source_id, instance)` and of its device (§8.3, `UploadLimiter`). Over
 *    either: 429
 *    `rate_limited` with `Retry-After` in whole seconds, and nothing of the
 *    `file` part that follows `meta` is buffered. (A `file` part sent before
 *    `meta` is buffered within its limit first, and not decompressed.)
 * 3. `file` is decompressed with an output limit of `maxBytes`, so a gzip
 *    bomb stops there (§8.3). Over it: 413 `too_large`.
 * 4. In one transaction that locks the device row: an upload whose sha256 is
 *    that of the last upload of its `(device, kit, source_id, instance)`
 *    stores nothing and gets 200 `duplicate`. Otherwise the kit's
 *    interpreter parses it (§6.2, §11), and the upload is stored. A parsed
 *    upload whose flavor the kit manifest's `flavors` registers gets its
 *    snapshot and 201 `stored` with `snapshot_uuid`. Experimental flavors
 *    are registered, so they are stored (D8). A `ParseError` keeps the upload
 *    with `parse_status = 'failed'` for a re-parse, and gets 422
 *    `parse_error` with the error's user-facing message.
 * 5. A parsed upload whose flavor is "unknown" or not registered is kept
 *    with `parse_status = 'rejected'` and its `flavor`, so rejections can be
 *    counted by flavor (§16.1), and gets no snapshot. It gets 422
 *    `unsupported_flavor` with a message that names the game, not the
 *    flavor (§8.3). For "unknown", ingest also logs the interpreter's
 *    `unknownFlavor` reason and raw facts as one JSON line, with the user's
 *    uuid as the only user identifier (§6.3.1).
 *
 * Every request that reaches step 4 sets the device's `last_seen_at`, and
 * its `os` and `bridge_version` when `meta.client` names them. A stored
 * upload also sets `first_upload_at` when it is still null.
 *
 * A malformed request gets 400 `bad_request` with a short message: a part
 * missing, extra, or of the wrong kind; `meta` that is not JSON or not the
 * §8.3 shape; a kit the registry does not hold, or a source its manifest does
 * not list; `file` that is not gzip; or a `meta.sha256` that is not the
 * sha256 of the decompressed bytes. Any kit in the registry is accepted,
 * whether or not the user has enabled it.
 *
 * `snapshot_at` is the adapter's stamp (`Parsed.capturedAt`), else
 * `meta.mtime`, else the receipt time (§6.2).
 */

/** The ingest limits (*proposed*, §0). `config.ts` reads them from the environment. */
export interface IngestSettings {
  /** `INGEST_MAX_UNCOMPRESSED_BYTES`: the cap on an upload's uncompressed bytes (§8.3). */
  maxBytes: number;
  /** `INGEST_RATE_PER_MINUTE`: uploads of one source instance of one device, per minute (§8.3). */
  ratePerMinute: number;
  /** `INGEST_BURST`: uploads of one source instance of one device, at once (§8.3). */
  burst: number;
  /** `INGEST_DEVICE_RATE_PER_MINUTE`: uploads of one device, all its instances together, per minute (§8.3). */
  deviceRatePerMinute: number;
  /** `INGEST_DEVICE_BURST`: uploads of one device, all its instances together, at once (§8.3). */
  deviceBurst: number;
}

/**
 * 5 MB of uncompressed bytes (§8.3), as the WoW interpreter counts them.
 * One upload per 5 seconds per instance, after a burst of 3, and one per
 * 2 seconds per device, after a burst of 10 (§8.3).
 */
export const DEFAULT_INGEST: IngestSettings = {
  maxBytes: 5 * 1024 * 1024,
  ratePerMinute: 12,
  burst: 3,
  deviceRatePerMinute: 30,
  deviceBurst: 10,
};

/** The most bytes the `meta` part may have. The §8.3 JSON is a few hundred. */
export const META_MAX_BYTES = 16 * 1024;

/**
 * The most bytes the `file` part may have: more than any gzip of `maxBytes`
 * bytes. zlib's `deflateBound` for gzip at the default settings is under
 * n + n/1024 + 1 KiB.
 */
export function maxCompressedBytes(maxBytes: number): number {
  return maxBytes + Math.ceil(maxBytes / 1024) + 1024;
}

export type IngestStatus = "stored" | "duplicate" | "parse_error" | "unsupported_flavor" | "too_large" | "rate_limited" | "bad_request";

/** The answer's body (§8.3). A 401 has none. */
export interface IngestAnswer {
  status: IngestStatus;
  /** For `parse_error`, the interpreter's user-facing message. For `unsupported_flavor`, one that names the game. */
  message?: string;
  /** For `stored`. */
  snapshot_uuid?: string;
}

/** The `meta` part (§8.3). The bridge is Go, so the names are snake_case. */
export interface IngestMeta {
  /** The manifest's `kit`, e.g. `wow`. */
  kit: string;
  /** The manifest source's `id`, e.g. `savedvariables`. */
  source_id: string;
  /** Lower-case hex SHA-256 of the instance path relative to the kit root. */
  instance: string;
  /** Lower-case hex SHA-256 of the uncompressed bytes. */
  sha256: string;
  /** The file's modification time, RFC 3339. */
  mtime?: string | null;
  client?: {
    bridge_version?: string;
    os?: string;
    /** Counts since the bridge's last successful upload, e.g. `{ "upload_failed": 2 }` (§16.1). */
    errors?: Record<string, number>;
  };
}

const HEX_SHA256 = "^[0-9a-f]{64}$";
const RFC_3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const ajv = new Ajv2020({ strict: true });
const validateMeta = ajv.compile<IngestMeta>({
  type: "object",
  required: ["kit", "source_id", "instance", "sha256"],
  properties: {
    kit: { type: "string", minLength: 1, maxLength: 64 },
    source_id: { type: "string", minLength: 1, maxLength: 64 },
    instance: { type: "string", pattern: HEX_SHA256 },
    sha256: { type: "string", pattern: HEX_SHA256 },
    mtime: { anyOf: [{ type: "string", maxLength: 64 }, { type: "null" }] },
    client: {
      type: "object",
      properties: {
        bridge_version: { type: "string", minLength: 1, maxLength: 64 },
        os: { type: "string", minLength: 1, maxLength: 64 },
        errors: {
          type: "object",
          maxProperties: 32,
          propertyNames: { type: "string", minLength: 1, maxLength: 64 },
          additionalProperties: { type: "integer", minimum: 0, maximum: 2_147_483_647 },
        },
      },
    },
  },
});

/** An answer to send. */
interface Outcome {
  http: 200 | 201 | 400 | 413 | 422 | 429;
  answer: IngestAnswer;
  /** The `Retry-After` header, in whole seconds. */
  retryAfter?: number;
}

function badRequest(message: string): Outcome {
  return { http: 400, answer: { status: "bad_request", message } };
}

function tooLarge(message: string): Outcome {
  return { http: 413, answer: { status: "too_large", message } };
}

function rateLimited(seconds: number): Outcome {
  return { http: 429, answer: { status: "rate_limited", message: `Too many uploads of this file. Try again in ${seconds} s.` }, retryAfter: seconds };
}

const MIB = 1024 * 1024;

function size(bytes: number): string {
  return Number.isInteger(bytes / MIB) ? `${bytes / MIB} MB` : `${bytes} bytes`;
}

const PARTS = "The request must have one meta form field and one file part.";

export interface IngestOptions {
  pool: Pool;
  kits: KitRegistry;
  settings: IngestSettings;
  /** Receives one JSON line per upload whose flavor is "unknown" (§6.3.1). Default: `console.log`. */
  log?: (line: string) => void;
}

/** The route's handler. It must run after `requireToken` for the bridge API with scope `ingest`. */
export function ingestHandler({ pool, kits, settings, log = console.log }: IngestOptions): RequestHandler {
  const limiter = new UploadLimiter(settings);
  return async (req, res) => {
    const token = currentToken(res);
    const device = token === null ? undefined : await findDevice(pool, token);
    if (device === undefined) return refuseDevice(res);

    // The limit's key is in `meta`, so it is taken as `meta` is read, before the file part.
    const parts = await readParts(req, maxCompressedBytes(settings.maxBytes), (text) => {
      const checked = checkMeta(text, kits);
      if ("http" in checked) return checked;
      const wait = limiter.take(device.id, uploadKey(device, checked));
      return wait > 0 ? rateLimited(wait) : checked;
    });
    if ("http" in parts) return reply(req, res, parts);
    const meta = parts.meta;

    let bytes: Buffer;
    try {
      bytes = await gunzipAsync(parts.file, { maxOutputLength: settings.maxBytes });
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === "ERR_BUFFER_TOO_LARGE") return reply(req, res, tooLarge(`The file is over ${size(settings.maxBytes)} uncompressed.`));
      return reply(req, res, badRequest("The file part is not gzip data."));
    }
    if (createHash("sha256").update(bytes).digest("hex") !== meta.sha256) {
      return reply(req, res, badRequest("meta.sha256 is not the SHA-256 of the uncompressed file."));
    }

    const outcome = await store(pool, device, meta, parts.file, bytes, log);
    if (outcome === null) return refuseDevice(res);
    reply(req, res, outcome);
  };
}

const gunzipAsync = promisify(gunzip);

function reply(req: Request, res: Response, { http, answer, retryAfter }: Outcome): void {
  // The rest of an unread body is dropped with the connection.
  if (!req.complete) res.set("Connection", "close");
  if (retryAfter !== undefined) res.set("Retry-After", String(retryAfter));
  res.status(http).json(answer);
}

/** As `requireToken` answers a revoked token: the bridge prompts a new login (§8.3). */
function refuseDevice(res: Response): void {
  res.set("WWW-Authenticate", 'Bearer error="invalid_token", error_description="the access token is not valid here", scope="ingest"');
  res.status(401).end();
}

interface Device {
  /** `devices.id`. */
  id: string;
  /** `users.id`. */
  userId: string;
  /** `users.uuid`: the only user identifier a log line holds. */
  userUuid: string;
}

/** The live device of the token's grant and user, or undefined. */
async function findDevice(pool: Pool, token: VerifiedToken): Promise<Device | undefined> {
  const { rows } = await pool.query<{ id: string; user_id: string }>(
    "select d.id, d.user_id from devices d join users u on u.id = d.user_id where d.grant_id = $1 and u.uuid = $2 and d.revoked_at is null",
    [token.grantId, token.userUuid],
  );
  const row = rows[0];
  return row === undefined ? undefined : { id: row.id, userId: row.user_id, userUuid: token.userUuid };
}

/**
 * Reads the `meta` field and the `file` part, within their limits.
 * `readMeta` checks `meta` as soon as it is read, before the part after it.
 * On a refusal, by a limit or by `readMeta`, it stops reading; `reply` then
 * closes the connection.
 */
function readParts(
  req: Request,
  maxFileBytes: number,
  readMeta: (text: string) => CheckedMeta | Outcome,
): Promise<{ meta: CheckedMeta; file: Buffer } | Outcome> {
  return new Promise((resolve) => {
    let parser: busboy.Busboy;
    try {
      parser = busboy({
        headers: req.headers,
        // A request has two parts. busboy emits partsLimit when a third one
        // ends, a part it skips (one without a form-data disposition) too.
        limits: { fields: 1, files: 1, parts: 3, fieldSize: META_MAX_BYTES, fileSize: maxFileBytes },
      });
    } catch {
      resolve(badRequest("The request must be multipart/form-data."));
      return;
    }
    let meta: CheckedMeta | undefined;
    let file: Buffer | undefined;
    let settled = false;
    function fail(outcome: Outcome): void {
      if (settled) return;
      settled = true;
      req.unpipe(parser);
      req.resume();
      resolve(outcome);
    }

    parser.on("field", (name, value, info) => {
      if (name !== "meta") return fail(badRequest(PARTS));
      if (info.valueTruncated) return fail(tooLarge(`The meta part is over ${META_MAX_BYTES} bytes.`));
      const checked = readMeta(value);
      if ("http" in checked) return fail(checked);
      meta = checked;
    });
    parser.on("file", (name, stream) => {
      // busboy destroys the stream with an error when the body ends inside
      // it. Unheard, that error would end the process.
      stream.on("error", () => fail(badRequest("The request is not valid multipart/form-data.")));
      if (name !== "file") {
        stream.resume();
        return fail(badRequest(PARTS));
      }
      // Refused at `meta`: the file is not read.
      if (settled) {
        stream.resume();
        return;
      }
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("limit", () => fail(tooLarge(`The file part is over ${size(maxFileBytes)}.`)));
      stream.on("end", () => {
        if (!stream.truncated) file = Buffer.concat(chunks);
      });
    });
    parser.on("fieldsLimit", () => fail(badRequest(PARTS)));
    parser.on("filesLimit", () => fail(badRequest(PARTS)));
    parser.on("partsLimit", () => fail(badRequest(PARTS)));
    parser.on("error", () => fail(badRequest("The request is not valid multipart/form-data.")));
    parser.on("close", () => {
      if (settled) return;
      if (meta === undefined || file === undefined) return fail(badRequest(PARTS));
      settled = true;
      resolve({ meta, file });
    });
    req.on("close", () => {
      if (!req.complete) fail(badRequest("The request ended early."));
    });
    req.pipe(parser);
  });
}

/** The instance rate limit's key: the upload's dedup key, `(device, kit, source_id, instance)` (§8.3). */
function uploadKey(device: Device, meta: CheckedMeta): string {
  return JSON.stringify([device.id, meta.kit.key, meta.sourceId, meta.instance]);
}

/** `meta`, checked. */
interface CheckedMeta {
  kit: Kit;
  sourceId: string;
  instance: string;
  sha256: string;
  mtime: Date | null;
  os: string | null;
  bridgeVersion: string | null;
  errors: Record<string, number> | null;
}

function checkMeta(text: string, kits: KitRegistry): CheckedMeta | Outcome {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return badRequest("The meta part is not JSON.");
  }
  if (!validateMeta(value)) return badRequest(ajv.errorsText(validateMeta.errors, { dataVar: "meta" }));
  const kit = kits.get(value.kit);
  if (kit === undefined) return badRequest("meta.kit names no kit this server has.");
  if (!kit.manifest.sources.some((source) => source.id === value.source_id)) {
    return badRequest("meta.source_id names no source of the kit.");
  }
  let mtime: Date | null = null;
  if (typeof value.mtime === "string") {
    mtime = new Date(value.mtime);
    if (!RFC_3339.test(value.mtime) || Number.isNaN(mtime.getTime()) || mtime.getTime() < 0) {
      return badRequest("meta.mtime must be an RFC 3339 time, such as 2026-09-24T18:02:11Z.");
    }
  }
  return {
    kit,
    sourceId: value.source_id,
    instance: value.instance,
    sha256: value.sha256,
    mtime,
    os: value.client?.os ?? null,
    bridgeVersion: value.client?.bridge_version ?? null,
    errors: value.client?.errors ?? null,
  };
}

/**
 * Steps 4 and 5 of the module comment, in one transaction. Answers null when
 * the device was revoked since `findDevice`.
 */
async function store(
  pool: Pool,
  device: Device,
  meta: CheckedMeta,
  gzipped: Buffer,
  bytes: Buffer,
  log: (line: string) => void,
): Promise<Outcome | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // The lock orders a device's uploads, so two of the same bytes cannot both pass the dedup check.
    const live = await client.query("select 1 from devices where id = $1 and revoked_at is null for update", [device.id]);
    if (live.rowCount === 0) {
      await client.query("rollback");
      return null;
    }

    const last = await client.query<{ sha256: string }>(
      "select sha256 from uploads where device_id = $1 and kit = $2 and source_id = $3 and instance = $4 order by id desc limit 1",
      [device.id, meta.kit.key, meta.sourceId, meta.instance],
    );
    if (last.rows[0]?.sha256 === meta.sha256) {
      await touchDevice(client, device, meta, false);
      await client.query("commit");
      return { http: 200, answer: { status: "duplicate" } };
    }

    let parsed: Parsed<unknown> | undefined;
    let parseError: string | null = null;
    try {
      parsed = meta.kit.interpreter.parse(meta.sourceId, bytes);
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
      parseError = err.message;
    }
    // "unknown" is never a key of `flavors` (the SDK's manifest schema).
    const rejectedFlavor = parsed !== undefined && !Object.hasOwn(meta.kit.manifest.flavors, parsed.flavor) ? parsed.flavor : null;

    const upload = await client.query<{ id: string; uuid: string }>(
      `insert into uploads (user_id, device_id, kit, source_id, instance, sha256, content_gzip, mtime, kit_version,
                            adapter_schema, parse_status, parse_error, flavor, client_errors)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       returning id, uuid`,
      [
        device.userId,
        device.id,
        meta.kit.key,
        meta.sourceId,
        meta.instance,
        meta.sha256,
        gzipped,
        meta.mtime,
        meta.kit.manifest.version,
        parsed?.adapterSchema ?? null,
        parsed === undefined ? "failed" : rejectedFlavor === null ? "parsed" : "rejected",
        parseError,
        rejectedFlavor,
        meta.errors === null ? null : JSON.stringify(meta.errors),
      ],
    );
    const uploadRow = upload.rows[0];
    if (uploadRow === undefined) throw new Error("insert into uploads returned no row");
    const uploadId = uploadRow.id;

    let snapshotUuid: string | undefined;
    if (parsed !== undefined && rejectedFlavor === null) {
      // now() is the transaction's start, which is also the upload's received_at.
      const snapshot = await client.query<{ uuid: string }>(
        `insert into snapshots (user_id, upload_id, kit, flavor, rules, character_key, character_name, character_realm,
                                snapshot_at, state)
         values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9::timestamptz, now()), $10)
         returning uuid`,
        [
          device.userId,
          uploadId,
          meta.kit.key,
          parsed.flavor,
          parsed.rules,
          parsed.character?.key ?? null,
          parsed.character?.name ?? null,
          parsed.character?.realm ?? null,
          parsed.capturedAt ?? meta.mtime,
          JSON.stringify(parsed.state),
        ],
      );
      snapshotUuid = snapshot.rows[0]?.uuid;
      if (snapshotUuid === undefined) throw new Error("insert into snapshots returned no row");
    }

    await touchDevice(client, device, meta, true);
    await client.query("commit");
    if (rejectedFlavor !== null) {
      if (rejectedFlavor === UNKNOWN_FLAVOR) log(unknownFlavorLine(device, meta.kit, uploadRow.uuid, parsed?.unknownFlavor));
      return { http: 422, answer: { status: "unsupported_flavor", message: `This version of ${meta.kit.name} isn't supported yet.` } };
    }
    if (snapshotUuid === undefined) return { http: 422, answer: { status: "parse_error", message: parseError ?? "" } };
    return { http: 201, answer: { status: "stored", snapshot_uuid: snapshotUuid } };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The flavor an interpreter returns for a payload that maps to no flavor (§6.3.1). */
const UNKNOWN_FLAVOR = "unknown";

/**
 * The log line for an upload whose flavor is "unknown": why, with the raw
 * detection facts, as JSON (§6.3.1, §16). The user's uuid is its only user
 * identifier.
 */
function unknownFlavorLine(device: Device, kit: Kit, uploadUuid: string, unknown: UnknownFlavor | undefined): string {
  return JSON.stringify({
    level: "warn",
    message: "ingest: unsupported_flavor for an unknown flavor",
    user_uuid: device.userUuid,
    upload_uuid: uploadUuid,
    kit: kit.key,
    reason: unknown?.reason ?? null,
    facts: unknown?.facts ?? null,
  });
}

/** Sets the device's `last_seen_at`, its versions, and, for a stored upload, `first_upload_at` when unset. */
async function touchDevice(client: PoolClient, device: Device, meta: CheckedMeta, stored: boolean): Promise<void> {
  await client.query(
    `update devices
        set last_seen_at = now(),
            os = coalesce($2, os),
            bridge_version = coalesce($3, bridge_version),
            first_upload_at = case when $4::boolean then coalesce(first_upload_at, now()) else first_upload_at end
      where id = $1`,
    [device.id, meta.os, meta.bridgeVersion, stored],
  );
}
