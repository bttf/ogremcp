import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";

import { ParseError } from "@ogmcp/sdk";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPool } from "./db.js";
import { KIT_SOURCES, type Kit, type KitRegistry } from "./kits/registry.js";
import { checkKits } from "./kits/validate.js";
import { migrate } from "./migrations.js";
import { type ParseStatus, type ReparseOptions, reparseUploads, type UploadSelection } from "./reparse-uploads.js";

/** As in migrations.test.ts: a Postgres server whose user may create databases. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"]?.trim() || undefined;
if (TEST_DATABASE_URL === undefined) console.warn("TEST_DATABASE_URL is not set: the Postgres tests in reparse-uploads.test.ts are skipped");

const DAY_S = 24 * 60 * 60;
const CAPTURED_AT = 1_790_000_000;
const CLASSIC_ERA_CLIENT = `{ ["project_id"] = 2, ["interface"] = 11509 }`;
/** Facts that map to the flavor "unknown" (§6.3.1): the interface is not Classic Era's. */
const UNKNOWN_CLIENT = `{ ["project_id"] = 2, ["interface"] = 20506 }`;

/** A SavedVariables file the WoW interpreter parses (§6.3), with synthetic data. */
function savedVariables(capturedAt: number, client = CLASSIC_ERA_CLIENT): string {
  return `OpenGamerMCPDB = {
  ["schema"] = 1,
  ["client"] = ${client},
  ["character"] = { ["guid"] = "Player-0000-00000001", ["name"] = "Zoela", ["realm"] = "Testrealm" },
  ["captured_at"] = ${capturedAt},
  ["state"] = { ["location"] = { ["zone"] = "Elwynn Forest" } },
}
`;
}

/**
 * The WoW kit; the same kit under the key `other`, so selection by kit has two
 * to pick from; and `broken`, whose interpreter now refuses every upload.
 */
function testKits(): KitRegistry {
  const checked = checkKits(KIT_SOURCES)[0];
  if (checked === undefined) throw new Error("no kit");
  const wow: Kit = { key: "wow", name: "World of Warcraft", manifest: checked.manifest, interpreter: checked.source.interpreter, adapter: null };
  const broken: Kit = {
    ...wow,
    key: "broken",
    interpreter: {
      parse: () => {
        throw new ParseError("A new interpreter bug refuses this.");
      },
      tools: [],
    },
  };
  const list = [wow, { ...wow, key: "other" }, broken];
  return { list: () => list, get: (key) => list.find((kit) => kit.key === key) };
}

describe.skipIf(TEST_DATABASE_URL === undefined)("re-parse stored uploads (§11)", () => {
  const name = `ogmcp_test_${randomBytes(6).toString("hex")}`;
  const kits = testKits();
  const version = kits.get("wow")?.manifest.version;
  let admin: Pool;
  let pool: Pool;
  let userId: string;
  let deviceId: string;

  beforeAll(async () => {
    admin = createPool({ url: TEST_DATABASE_URL ?? "", queryTimeoutMs: 10_000, max: 1 });
    await admin.query(`create database "${name}"`);
    const url = new URL(TEST_DATABASE_URL ?? "");
    url.pathname = `/${name}`;
    pool = createPool({ url: url.toString(), queryTimeoutMs: 10_000, max: 2 });
    await migrate(pool);
    const { rows: users } = await pool.query<{ id: string }>("insert into users default values returning id");
    userId = users[0]?.id ?? "";
    const { rows: devices } = await pool.query<{ id: string }>("insert into devices (user_id) values ($1) returning id", [userId]);
    deviceId = devices[0]?.id ?? "";
  });

  afterAll(async () => {
    await pool?.end();
    try {
      await admin.query(`drop database if exists "${name}" with (force)`);
    } finally {
      await admin.end();
    }
  });

  // The command selects across users, so each test starts with no uploads.
  beforeEach(async () => {
    await pool.query("truncate snapshots, uploads");
  });

  /** Stores an upload of `text` as an older kit left it, with `status`, and answers its id. */
  async function addUpload(text: string, status: ParseStatus, { kit = "wow", receivedAt = new Date() } = {}): Promise<string> {
    const bytes = Buffer.from(text);
    const { rows } = await pool.query<{ id: string }>(
      `insert into uploads (user_id, device_id, kit, source_id, instance, sha256, content_gzip, mtime, kit_version,
                            adapter_schema, parse_status, parse_error, flavor, received_at)
       values ($1, $2, $3, 'savedvariables', $4, $5, $6, null, '0.0.1', $7, $8, $9, $10, $11) returning id`,
      [
        userId,
        deviceId,
        kit,
        randomBytes(32).toString("hex"),
        createHash("sha256").update(bytes).digest("hex"),
        gzipSync(bytes),
        status === "failed" ? null : 1,
        status,
        status === "failed" ? "An older interpreter refused this." : null,
        status === "rejected" ? "tbc_classic" : null,
        receivedAt,
      ],
    );
    return rows[0]?.id ?? "";
  }

  /** Every upload and snapshot row, with `xmin`, which changes on any write. */
  async function rows() {
    const uploads = await pool.query(
      "select id, xmin::text, kit_version, adapter_schema, parse_status, parse_error, flavor from uploads order by id",
    );
    const snapshots = await pool.query("select upload_id, uuid, xmin::text, flavor, snapshot_at from snapshots order by upload_id");
    return { uploads: uploads.rows, snapshots: snapshots.rows };
  }

  /** What the re-parse logged for "unknown" flavors. */
  const logged: string[] = [];

  function reparse(selection: UploadSelection = {}, options: Pick<ReparseOptions, "allowRegressions" | "dryRun"> = {}) {
    return reparseUploads({
      pool,
      kits,
      maxBytes: 5 * 1024 * 1024,
      selection,
      pageSize: 2,
      log: (line) => logged.push(line),
      logError: () => {},
      ...options,
    });
  }

  /** Stores a snapshot of the parsed upload `uploadId`, as an older kit left it. */
  async function addSnapshot(uploadId: string): Promise<void> {
    await pool.query(
      `insert into snapshots (user_id, upload_id, kit, flavor, rules, snapshot_at, state)
       values ($1, $2, (select kit from uploads where id = $2), 'classic_era', '{}', now(), '{}')`,
      [userId, uploadId],
    );
  }

  it("stores a failed upload that now parses, logs a new unknown flavor, and changes nothing on a second run", async () => {
    const failed = await addUpload(savedVariables(CAPTURED_AT), "failed");
    const unknown = await addUpload(savedVariables(CAPTURED_AT, UNKNOWN_CLIENT), "rejected");
    const stillFailed = await addUpload(savedVariables(CAPTURED_AT).replace('["zone"] = "Elwynn Forest"', '["zone"] = 5'), "failed");
    logged.length = 0;

    expect(await reparse()).toEqual({ "failed -> parsed": 1, "rejected -> rejected": 1, "failed -> failed": 1 });
    const first = await rows();
    expect(first.uploads).toMatchObject([
      { id: failed, kit_version: version, adapter_schema: 1, parse_status: "parsed", parse_error: null, flavor: null },
      { id: unknown, kit_version: version, adapter_schema: 1, parse_status: "rejected", parse_error: null, flavor: "unknown" },
      // A failure after the schema and the client facts were read records them (§16.1).
      { id: stillFailed, kit_version: version, adapter_schema: 1, parse_status: "failed", parse_error: expect.any(String), flavor: "classic_era" },
    ]);
    expect(first.snapshots).toMatchObject([{ upload_id: failed, flavor: "classic_era", snapshot_at: new Date(CAPTURED_AT * 1000) }]);
    expect(logged.map((line) => JSON.parse(line))).toMatchObject([{ kit: "wow", facts: { interface: 20506 } }]);

    expect(await reparse()).toEqual({ unchanged: 3 });
    expect(await rows()).toEqual(first);
    expect(logged).toHaveLength(1);
  });

  it("leaves a parsed upload whose kit now refuses it untouched, unless regressions are allowed", async () => {
    const upload = await addUpload(savedVariables(CAPTURED_AT), "parsed", { kit: "broken" });
    await addSnapshot(upload);
    const before = await rows();

    expect(await reparse({}, { dryRun: true })).toEqual({ regressed: 1 });
    expect(await reparse()).toEqual({ regressed: 1 });
    expect(await rows()).toEqual(before);

    expect(await reparse({}, { allowRegressions: true, dryRun: true })).toEqual({ "parsed -> failed": 1 });
    expect(await rows()).toEqual(before);
    expect(await reparse({}, { allowRegressions: true })).toEqual({ "parsed -> failed": 1 });
    const after = await rows();
    expect(after.uploads).toMatchObject([{ parse_status: "failed", parse_error: "A new interpreter bug refuses this.", adapter_schema: null }]);
    expect(after.snapshots).toEqual([]);
  });

  it("judges captured_at against received_at, so snapshot_at does not change on a later day", async () => {
    // Two days after receipt: unknown at ingest, and still unknown now, long after.
    const receivedAt = new Date("2026-01-01T00:00:00Z");
    await addUpload(savedVariables(receivedAt.getTime() / 1000 + 2 * DAY_S), "failed", { receivedAt });

    expect(await reparse()).toEqual({ "failed -> parsed": 1 });
    expect((await rows()).snapshots).toMatchObject([{ snapshot_at: receivedAt }]);
  });

  it("selects by kit and parse status", async () => {
    const text = savedVariables(CAPTURED_AT);
    const selected = await addUpload(text, "failed");
    await addUpload(text, "rejected");
    await addUpload(text, "failed", { kit: "other" });
    const selection: UploadSelection = { kits: ["wow"], statuses: ["failed"] };

    expect(await reparse(selection, { dryRun: true })).toEqual({ "failed -> parsed": 1 });
    expect(await reparse(selection)).toEqual({ "failed -> parsed": 1 });
    const { uploads } = await rows();
    expect(uploads.map((upload) => [upload.id, upload.parse_status])).toEqual([
      [selected, "parsed"],
      [expect.any(String), "rejected"],
      [expect.any(String), "failed"],
    ]);
  });
});
