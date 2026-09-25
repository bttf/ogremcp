import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import { ParseError, type Parsed, type UnknownFlavor } from "@ogmcp/sdk";
import { Ajv2020 } from "ajv/dist/2020.js";
import busboy from "busboy";
import type { Request, RequestHandler, Response } from "express";
import type { Pool, PoolClient } from "pg";

import { liveDeviceSql } from "./devices.js";
import type { EventRecorder, IngestEvent } from "./events.js";
import { UploadLimiter } from "./ingest-limit.js";
import type { Kit, KitRegistry } from "./kits/registry.js";
import { formatLine, writeLine } from "./log.js";
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
 *    `meta` is buffered within its limit first, and not decompressed.) Then
 *    the device limit, as `findDevice` read it: a device without one of its
 *    user's upload slots gets 403 `device_limit` with a message that says
 *    how to switch devices, and the `file` part is not read either.
 * 3. `file` is decompressed with an output limit of `maxBytes`, so a gzip
 *    bomb stops there (§8.3). Over it: 413 `too_large`.
 * 4. In one transaction that locks the device row, and then the user's row
 *    for a device that has not claimed a slot: the device limit is checked
 *    again under the locks, so two devices cannot claim the last slot at
 *    once. An upload whose sha256 is that of the last upload of its
 *    `(device, kit, source_id, instance)` stores nothing and gets 200
 *    `duplicate`. Otherwise the kit's
 *    interpreter parses it (§6.2, §11), and the upload is stored. A parsed
 *    upload whose flavor the kit manifest's `flavors` registers gets its
 *    snapshot and 201 `stored` with `snapshot_uuid`. Experimental flavors
 *    are registered, so they are stored (D8). A `ParseError` keeps the upload
 *    with `parse_status = 'failed'` for a re-parse, with the adapter schema
 *    and flavor the interpreter read before it failed (§16.1), and gets 422
 *    `parse_error` with the error's user-facing message.
 * 5. A parsed upload whose flavor is "unknown" or not registered is kept
 *    with `parse_status = 'rejected'` and its `flavor`, so rejections can be
 *    counted by flavor (§16.1), and gets no snapshot. It gets 422
 *    `unsupported_flavor` with a message that names the game, not the
 *    flavor (§8.3). For "unknown", ingest also logs the interpreter's
 *    `unknownFlavor` reason and raw facts as one JSON line, with the user's
 *    uuid as the only user identifier (§6.3.1).
 *
 * Every request that passes the device limit in step 4 sets the device's
 * `last_seen_at`, and its `os` and `bridge_version` when `meta.client` names
 * them. A stored upload also sets `first_upload_at` when it is still null,
 * and one that got a snapshot sets `first_stored_at`, which claims a slot.
 *
 * The device limit (§8.3, §14, D10): a user of each tier uploads from at
 * most `DeviceLimits` devices, one on the free tier. Approval does not depend
 * on it (§8.1). The user's upload slots go to their live devices in the order
 * of their first upload that got a snapshot (`devices.first_stored_at`); an
 * upload that fails to parse or has an unsupported flavor claims none. A
 * device that is revoked, or whose grant is gone (`liveDeviceSql`), holds
 * none, so revoking the slot's device frees it. The tier is read on each
 * request, so a tier change applies to the next upload. A downgrade deletes
 * no device: the devices that claimed their slots last, past the new limit,
 * get `device_limit`.
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
 *
 * An answer writes one events row (`events.ts`, §16.1) after it is sent:
 * the user, the device, the status, the latency, and what is known of the
 * upload by then: `meta.client`, the kit and its version, and the parse's
 * status, flavor, and adapter schema. `bad_request` and `rate_limited`
 * answers write none, so a device that loops on them cannot grow the table;
 * the access log has them. Nor does a 401, which names no live device.
 * `device_limit` answers write one: the rate limit comes first, so a device
 * that loops on it writes no more rows than one that uploads, and the rows
 * count how often users meet the limit (§14, §16.1). A request that fails
 * with an error in step 4, such as an interpreter crash, writes one with
 * status `error`, and the app answers 500.
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
  /** `DEVICES_PER_USER_FREE` and `DEVICES_PER_USER_PAID`: the device limit (§8.3, §14). */
  devicesPerUser: DeviceLimits;
}

/**
 * The most devices a user of each tier uploads from (§8.3, §14): the number
 * of the user's upload slots. Null is no limit.
 */
export interface DeviceLimits {
  readonly free: number;
  readonly paid: number | null;
}

/**
 * 5 MB of uncompressed bytes (§8.3), as the WoW interpreter counts them.
 * One upload per 5 seconds per instance, after a burst of 3, and one per
 * 2 seconds per device, after a burst of 10 (§8.3). One device on the free
 * tier, and no limit on the paid tier (§14).
 */
export const DEFAULT_INGEST: IngestSettings = {
  maxBytes: 5 * 1024 * 1024,
  ratePerMinute: 12,
  burst: 3,
  deviceRatePerMinute: 30,
  deviceBurst: 10,
  devicesPerUser: { free: 1, paid: null },
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

export type IngestStatus =
  | "stored"
  | "duplicate"
  | "parse_error"
  | "unsupported_flavor"
  | "too_large"
  | "device_limit"
  | "rate_limited"
  | "bad_request";

/** The answer's body (§8.3). A 401 has none. */
export interface IngestAnswer {
  status: IngestStatus;
  /**
   * For `parse_error`, the interpreter's user-facing message. For
   * `unsupported_flavor`, one that names the game. For `device_limit`, one
   * that says how to switch devices.
   */
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
  http: 200 | 201 | 400 | 403 | 413 | 422 | 429;
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

/**
 * The answer to a device past the device limit (§8.3), whose tier has
 * `limit` slots. The message is the bridge's to show (§7): it says how to
 * switch devices, on the Devices page (§13.2).
 */
function deviceLimited(limit: number, publicBaseUrl: string): Outcome {
  const page = `the Devices page: ${publicBaseUrl}/devices`;
  const message =
    limit === 1
      ? `Another of your bridges uploads for this account. To upload from this one, revoke the other on ${page}`
      : `${limit} of your other bridges upload for this account, the most it allows. To upload from this one, revoke one of them on ${page}`;
  return { http: 403, answer: { status: "device_limit", message } };
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
  /** `PUBLIC_BASE_URL`, for the Devices page's address in a `device_limit` message. */
  publicBaseUrl: string;
  /** Receives one JSON line per upload whose flavor is "unknown" (§6.3.1). Default: the platform's log, at `warn`. */
  log?: (line: string) => void;
  /** Where each request's events row goes (§16.1). Default: none, and nothing is recorded. */
  events?: EventRecorder;
}

/** The route's handler. It must run after `requireToken` for the bridge API with scope `ingest`. */
export function ingestHandler({
  pool,
  kits,
  settings,
  publicBaseUrl,
  log = (line) => writeLine("warn", line),
  events,
}: IngestOptions): RequestHandler {
  const limiter = new UploadLimiter(settings);
  return async (req, res) => {
    const occurredAt = new Date();
    const started = performance.now();
    const token = currentToken(res);
    const device = token === null ? undefined : await findDevice(pool, token);
    if (device === undefined) return refuseDevice(res);

    /** `meta`, once checked. */
    let checked: CheckedMeta | null = null;
    /** Records the request with `status`. */
    const record = (status: IngestEvent["status"], parse: UploadParse | null): void => {
      events?.record(ingestEvent(device, occurredAt, performance.now() - started, status, checked, parse));
    };
    /** Sends the answer, then records the request, unless it is a refusal a looping device can repeat. */
    const finish = (outcome: Outcome, parse: UploadParse | null = null): void => {
      reply(req, res, outcome);
      const { status } = outcome.answer;
      if (status !== "bad_request" && status !== "rate_limited") record(status, parse);
    };

    // The limit's key is in `meta`, so it is taken as `meta` is read, before the file part.
    // The device limit comes after it, so a device that loops on `device_limit` meets the rate limit.
    const parts = await readParts(req, maxCompressedBytes(settings.maxBytes), (text) => {
      const result = checkMeta(text, kits);
      if ("http" in result) return result;
      checked = result;
      const wait = limiter.take(device.id, uploadKey(device, result));
      if (wait > 0) return rateLimited(wait);
      const limit = overLimit(device, settings.devicesPerUser);
      return limit === null ? result : deviceLimited(limit, publicBaseUrl);
    });
    if ("http" in parts) return finish(parts);
    const meta = parts.meta;

    let bytes: Buffer;
    try {
      bytes = await decompress(parts.file, settings.maxBytes);
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === "ERR_BUFFER_TOO_LARGE") return finish(tooLarge(`The file is over ${size(settings.maxBytes)} uncompressed.`));
      return finish(badRequest("The file part is not gzip data."));
    }
    if (createHash("sha256").update(bytes).digest("hex") !== meta.sha256) {
      return finish(badRequest("meta.sha256 is not the SHA-256 of the uncompressed file."));
    }

    let stored: Awaited<ReturnType<typeof store>>;
    try {
      stored = await store(pool, device, settings.devicesPerUser, meta, parts.file, bytes, log);
    } catch (err) {
      // An interpreter crash or a database failure. The app's error handler answers 500.
      record("error", null);
      throw err;
    }
    if (stored === null) return refuseDevice(res);
    if ("overLimit" in stored) return finish(deviceLimited(stored.overLimit, publicBaseUrl));
    finish(stored.outcome, stored.parse);
  };
}

/** The events row of a request of `device` with `status`. */
function ingestEvent(
  device: Device,
  occurredAt: Date,
  latencyMs: number,
  status: IngestEvent["status"],
  meta: CheckedMeta | null,
  parse: UploadParse | null,
): IngestEvent {
  return {
    kind: "ingest",
    userId: device.userId,
    deviceId: device.id,
    occurredAt,
    latencyMs,
    status,
    meta: meta && {
      kit: meta.kit.key,
      kitVersion: meta.kit.manifest.version,
      bridgeVersion: meta.bridgeVersion,
      os: meta.os,
      errors: meta.errors,
    },
    parse,
  };
}

const gunzipAsync = promisify(gunzip);

/**
 * An upload's bytes, from their gzip, with an output limit of `maxBytes`, so
 * a gzip bomb stops there (§8.3). Over it, the promise rejects with code
 * `ERR_BUFFER_TOO_LARGE`. Ingest and the re-parse command (§11) share it.
 */
export function decompress(gzipped: Buffer, maxBytes: number): Promise<Buffer> {
  return gunzipAsync(gzipped, { maxOutputLength: maxBytes });
}

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

/** A device's place in the device limit (§8.3, §14), as `SLOT_COLUMNS` reads it. */
interface Slot {
  /** `users.tier`. */
  tier: keyof DeviceLimits;
  /** Whether the device has claimed a slot: `first_stored_at` is set. */
  claimed: boolean;
  /** How many of the user's other live devices hold a slot ahead of it. */
  ahead: number;
}

/**
 * `Slot`'s columns, for the device `devices me` and its user `users u`.
 * Slots go in the order of `first_stored_at`, then `id`, and a device without
 * `first_stored_at` comes after every device with one. Only live devices
 * (`liveDeviceSql`) hold one. `devices_user` indexes the count.
 */
const SLOT_COLUMNS = `u.tier, me.first_stored_at is not null as claimed,
  (select count(*) from devices h
    where h.user_id = me.user_id and h.id <> me.id and h.first_stored_at is not null and ${liveDeviceSql("h")}
      and (h.first_stored_at, h.id) < (coalesce(me.first_stored_at, 'infinity'), me.id))::int as ahead`;

/** The tier's limit when it refuses the device: its slots are all held ahead of it. Null when the device may upload. */
function overLimit(slot: Slot, limits: DeviceLimits): number | null {
  const limit = limits[slot.tier];
  return limit !== null && slot.ahead >= limit ? limit : null;
}

interface Device extends Slot {
  /** `devices.id`. */
  id: string;
  /** `users.id`. */
  userId: string;
  /** `users.uuid`: the only user identifier a log line holds. */
  userUuid: string;
}

/** The live device of the token's grant and user, with its place in the device limit, or undefined. */
async function findDevice(pool: Pool, token: VerifiedToken): Promise<Device | undefined> {
  const { rows } = await pool.query<{ id: string; user_id: string } & Slot>(
    `select me.id, me.user_id, ${SLOT_COLUMNS}
       from devices me join users u on u.id = me.user_id
      where me.grant_id = $1 and u.uuid = $2 and me.revoked_at is null`,
    [token.grantId, token.userUuid],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  return { id: row.id, userId: row.user_id, userUuid: token.userUuid, tier: row.tier, claimed: row.claimed, ahead: row.ahead };
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
 * Steps 4 and 5 of the module comment, in one transaction. Answers the
 * outcome and how the upload parsed (null for a duplicate); or the tier's
 * limit, when the device limit refuses the device (`overLimit`); or null when
 * the device was revoked since `findDevice`.
 */
async function store(
  pool: Pool,
  device: Device,
  limits: DeviceLimits,
  meta: CheckedMeta,
  gzipped: Buffer,
  bytes: Buffer,
  log: (line: string) => void,
): Promise<{ outcome: Outcome; parse: UploadParse | null } | { overLimit: number } | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // The lock orders a device's uploads, so two of the same bytes cannot both pass the dedup check.
    const live = await client.query("select 1 from devices where id = $1 and revoked_at is null for update", [device.id]);
    if (live.rowCount === 0) {
      await client.query("rollback");
      return null;
    }
    // A device that has not claimed a slot also locks its user's row, so the user's devices claim slots one at a
    // time and two cannot both take the last one. The device first, then the user, as the inserts below take them.
    // `no key update` leaves the key-share locks of foreign keys to the user free.
    if (!device.claimed) await client.query("select 1 from users where id = $1 for no key update", [device.userId]);
    const slot = await client.query<Slot>(`select ${SLOT_COLUMNS} from devices me join users u on u.id = me.user_id where me.id = $1`, [device.id]);
    const limit = slot.rows[0] === undefined ? null : overLimit(slot.rows[0], limits);
    if (limit !== null) {
      await client.query("rollback");
      return { overLimit: limit };
    }

    const last = await client.query<{ sha256: string }>(
      "select sha256 from uploads where device_id = $1 and kit = $2 and source_id = $3 and instance = $4 order by id desc limit 1",
      [device.id, meta.kit.key, meta.sourceId, meta.instance],
    );
    if (last.rows[0]?.sha256 === meta.sha256) {
      await touchDevice(client, device, meta, false, false);
      await client.query("commit");
      return { outcome: { http: 200, answer: { status: "duplicate" } }, parse: null };
    }

    const result = parseUpload(meta.kit, meta.sourceId, bytes);

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
        result.adapterSchema,
        result.status,
        result.parseError,
        result.flavor,
        meta.errors === null ? null : JSON.stringify(meta.errors),
      ],
    );
    const uploadRow = upload.rows[0];
    if (uploadRow === undefined) throw new Error("insert into uploads returned no row");
    const uploadId = uploadRow.id;

    let snapshotUuid: string | undefined;
    if (result.status === "parsed") {
      snapshotUuid = (await writeSnapshot(client, uploadId, result.parsed)) ?? undefined;
      if (snapshotUuid === undefined) throw new Error("insert into snapshots returned no row");
    }

    await touchDevice(client, device, meta, true, snapshotUuid !== undefined);
    await client.query("commit");
    if (result.status === "rejected") {
      if (result.flavor === UNKNOWN_FLAVOR) log(unknownFlavorLine(device.userUuid, meta.kit, uploadRow.uuid, result.parsed.unknownFlavor));
      return {
        outcome: { http: 422, answer: { status: "unsupported_flavor", message: `This version of ${meta.kit.name} isn't supported yet.` } },
        parse: result,
      };
    }
    if (snapshotUuid === undefined) return { outcome: { http: 422, answer: { status: "parse_error", message: result.parseError ?? "" } }, parse: result };
    return { outcome: { http: 201, answer: { status: "stored", snapshot_uuid: snapshotUuid } }, parse: result };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * What an upload's bytes parse to (§6.2), with the `uploads` columns that
 * record it (§11): `parse_status`, `parse_error`, `adapter_schema`, and
 * `flavor`.
 */
export type UploadParse =
  /** A flavor the kit manifest's `flavors` registers. It gets a snapshot, which holds the flavor. */
  | { status: "parsed"; parsed: Parsed<unknown>; parseError: null; adapterSchema: number; flavor: null }
  /** A flavor that is "unknown" or not registered (§6.3.1). No snapshot. */
  | { status: "rejected"; parsed: Parsed<unknown>; parseError: null; adapterSchema: number; flavor: string }
  /**
   * The interpreter threw a `ParseError`: its user-facing message, and the
   * adapter schema and flavor it read before it failed, or null for each it
   * had not read (§16.1). No snapshot.
   */
  | { status: "failed"; parsed: null; parseError: string; adapterSchema: number | null; flavor: string | null };

/**
 * Parses an upload of the kit's source `sourceId` with the kit's interpreter
 * and checks its flavor against the manifest (§6.1, §8.3). Ingest and the
 * re-parse command (§11) share it. `now` is `ParseOptions.now`: the re-parse
 * passes the upload's receipt time. An error other than `ParseError` is a
 * kit bug, and propagates. A `ParseError`'s adapter schema is kept only when
 * it fits an `integer` column, and its flavor only when it is a snake_case
 * key of at most `FLAVOR_MAX_LENGTH` characters.
 */
export function parseUpload(kit: Kit, sourceId: string, bytes: Uint8Array, now?: Date): UploadParse {
  let parsed: Parsed<unknown>;
  try {
    parsed = kit.interpreter.parse(sourceId, bytes, now === undefined ? undefined : { now });
  } catch (err) {
    if (!(err instanceof ParseError)) throw err;
    return {
      status: "failed",
      parsed: null,
      parseError: err.message,
      adapterSchema: intOrNull(err.adapterSchema),
      flavor: flavorOrNull(err.flavor),
    };
  }
  // "unknown" is never a key of `flavors` (the SDK's manifest schema).
  if (!Object.hasOwn(kit.manifest.flavors, parsed.flavor)) {
    return { status: "rejected", parsed, parseError: null, adapterSchema: parsed.adapterSchema, flavor: parsed.flavor };
  }
  return { status: "parsed", parsed, parseError: null, adapterSchema: parsed.adapterSchema, flavor: null };
}

/** The longest flavor key a failed parse records. */
const FLAVOR_MAX_LENGTH = 64;

/** A flavor key: lowercase snake_case, as the SDK's manifest schema has it. "unknown" is one. */
const FLAVOR_KEY = /^[a-z0-9]+(_[a-z0-9]+)*$/;

/** `value` when it fits an `integer` column, else null. */
function intOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647 ? value : null;
}

/** `value` when it is a flavor key of at most `FLAVOR_MAX_LENGTH` characters, else null. */
function flavorOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length <= FLAVOR_MAX_LENGTH && FLAVOR_KEY.test(value) ? value : null;
}

/**
 * Stores the snapshot of the parsed upload `uploadId` (§11): inserts it, or
 * replaces the upload's snapshot in place, which keeps its uuid. Answers the
 * snapshot's uuid, or null when the upload's snapshot already holds this
 * parse and nothing was written. `snapshot_at` is the adapter's stamp
 * (`Parsed.capturedAt`), else the upload's `mtime`, else its `received_at`
 * (§6.2). Ingest and the re-parse command share it.
 */
export async function writeSnapshot(client: PoolClient, uploadId: string, parsed: Parsed<unknown>): Promise<string | null> {
  const { rows } = await client.query<{ uuid: string }>(
    `insert into snapshots (user_id, upload_id, kit, flavor, rules, character_key, character_name, character_realm,
                            snapshot_at, state)
     select u.user_id, u.id, u.kit, $2::text, $3::text[], $4::text, $5::text, $6::text,
            coalesce($7::timestamptz, u.mtime, u.received_at), $8::jsonb
       from uploads u
      where u.id = $1
     on conflict (upload_id) do update
        set flavor = excluded.flavor, rules = excluded.rules, character_key = excluded.character_key,
            character_name = excluded.character_name, character_realm = excluded.character_realm,
            snapshot_at = excluded.snapshot_at, state = excluded.state
      where (snapshots.flavor, snapshots.rules, snapshots.character_key, snapshots.character_name,
             snapshots.character_realm, snapshots.snapshot_at, snapshots.state)
            is distinct from (excluded.flavor, excluded.rules, excluded.character_key, excluded.character_name,
             excluded.character_realm, excluded.snapshot_at, excluded.state)
     returning uuid`,
    [
      uploadId,
      parsed.flavor,
      parsed.rules,
      parsed.character?.key ?? null,
      parsed.character?.name ?? null,
      parsed.character?.realm ?? null,
      parsed.capturedAt,
      JSON.stringify(parsed.state),
    ],
  );
  return rows[0]?.uuid ?? null;
}

/** The flavor an interpreter returns for a payload that maps to no flavor (§6.3.1). */
export const UNKNOWN_FLAVOR = "unknown";

/**
 * The log line for an upload whose flavor is "unknown": why, with the raw
 * detection facts, as the platform's log writes it (§6.3.1, §16). The user's
 * uuid is its only user identifier. The re-parse command writes it too.
 */
export function unknownFlavorLine(userUuid: string, kit: Kit, uploadUuid: string, unknown: UnknownFlavor | undefined): string {
  return formatLine("warn", "ingest: unsupported_flavor for an unknown flavor", {
    user_uuid: userUuid,
    upload_uuid: uploadUuid,
    kit: kit.key,
    reason: unknown?.reason ?? null,
    facts: unknown?.facts ?? null,
  });
}

/**
 * Sets the device's `last_seen_at` and its versions; for a stored upload,
 * `first_upload_at` when unset; and for one that got a snapshot,
 * `first_stored_at` when unset, which claims a slot of the device limit.
 */
async function touchDevice(client: PoolClient, device: Device, meta: CheckedMeta, stored: boolean, snapshot: boolean): Promise<void> {
  await client.query(
    `update devices
        set last_seen_at = now(),
            os = coalesce($2, os),
            bridge_version = coalesce($3, bridge_version),
            first_upload_at = case when $4::boolean then coalesce(first_upload_at, now()) else first_upload_at end,
            first_stored_at = case when $5::boolean then coalesce(first_stored_at, now()) else first_stored_at end
      where id = $1`,
    [device.id, meta.os, meta.bridgeVersion, stored, snapshot],
  );
}
