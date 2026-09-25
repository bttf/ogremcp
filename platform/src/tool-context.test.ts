import { randomBytes, randomUUID } from "node:crypto";

import type { Character } from "@ogmcp/sdk";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool } from "./db.js";
import { migrate } from "./migrations.js";
import { createToolContext, DEFAULT_TOOL_CONTEXT, findToolUser, type ToolContextSettings, UserFacingError } from "./tool-context.js";

/** As in migrations.test.ts: a Postgres server whose user may create databases. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"]?.trim() || undefined;
if (TEST_DATABASE_URL === undefined) console.warn("TEST_DATABASE_URL is not set: the Postgres tests in tool-context.test.ts are skipped");

const ZOELA: Character = { key: "Player-0000-00000001", name: "Zoela", realm: "Testrealm" };
const BRANNIC: Character = { key: "Player-0000-00000002", name: "Brannic", realm: "Testrealm" };
const ZOELA_OTHER: Character = { key: "Player-0000-00000003", name: "Zoela", realm: "Otherrealm" };

function at(hour: number): Date {
  return new Date(Date.UTC(2026, 8, 24, hour));
}

describe.skipIf(TEST_DATABASE_URL === undefined)("ToolContext (§6.2)", () => {
  const name = `ogmcp_test_${randomBytes(6).toString("hex")}`;
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool({ url: TEST_DATABASE_URL ?? "", queryTimeoutMs: 10_000, max: 1 });
    await admin.query(`create database "${name}"`);
    const url = new URL(TEST_DATABASE_URL ?? "");
    url.pathname = `/${name}`;
    pool = createPool({ url: url.toString(), queryTimeoutMs: 10_000, max: 2 });
    await migrate(pool);
  });

  afterAll(async () => {
    await pool?.end();
    try {
      await admin.query(`drop database if exists "${name}" with (force)`);
    } finally {
      await admin.end();
    }
  });

  /** A user with a device, and a function that stores one snapshot of theirs, in insert order. */
  async function newUser(): Promise<{ uuid: string; add(snapshotAt: Date, flavor: string, character: Character | null): Promise<void> }> {
    const { rows: users } = await pool.query<{ id: string; uuid: string }>("insert into users default values returning id, uuid");
    const user = users[0];
    if (user === undefined) throw new Error("no user row");
    const { rows: devices } = await pool.query<{ id: string }>("insert into devices (user_id) values ($1) returning id", [user.id]);
    const deviceId = devices[0]?.id;
    return {
      uuid: user.uuid,
      async add(snapshotAt, flavor, character) {
        const hex = () => randomBytes(32).toString("hex");
        const { rows } = await pool.query<{ id: string }>(
          `insert into uploads (user_id, device_id, kit, source_id, instance, sha256, content_gzip, kit_version, adapter_schema, parse_status)
           values ($1, $2, 'wow', 'savedvariables', $3, $4, '\\x00', '0.1.0', 1, 'parsed') returning id`,
          [user.id, deviceId, hex(), hex()],
        );
        await pool.query(
          `insert into snapshots (user_id, upload_id, kit, flavor, rules, character_key, character_name, character_realm, snapshot_at, state)
           values ($1, $2, 'wow', $3, '{}', $4, $5, $6, $7, $8)`,
          [user.id, rows[0]?.id, flavor, character?.key, character?.name, character?.realm, snapshotAt, { at: snapshotAt.toISOString() }],
        );
      },
    };
  }

  async function contextOf(uuid: string, settings: ToolContextSettings = DEFAULT_TOOL_CONTEXT) {
    const user = await findToolUser(pool, uuid);
    if (user === null) throw new Error("no user");
    return createToolContext({ pool, user, kit: "wow", settings });
  }

  it("orders by snapshot_at, not insert time, and caps history at maxHistoryLimit", async () => {
    const user = await newUser();
    await user.add(at(10), "classic_era", ZOELA);
    await user.add(at(12), "classic_era", ZOELA);
    // Arrives late: an offline upload of an older capture.
    await user.add(at(11), "classic_era", ZOELA);
    const ctx = await contextOf(user.uuid);

    expect(Object.keys(ctx).sort()).toEqual(["history", "latest", "maxResultBytes", "user"]);
    expect(ctx.user).toEqual({ uuid: user.uuid, tier: "free" });
    expect(await ctx.latest({})).toEqual({
      snapshotAt: at(12),
      flavor: "classic_era",
      rules: [],
      character: ZOELA,
      state: { at: at(12).toISOString() },
    });
    const times = (list: { snapshotAt: Date }[]) => list.map((s) => s.snapshotAt.getUTCHours());
    expect(times(await ctx.history({ since: at(9), limit: 10 }))).toEqual([12, 11, 10]);
    expect(times(await ctx.history({ since: at(11), limit: 10 }))).toEqual([12, 11]);

    const capped = await contextOf(user.uuid, { ...DEFAULT_TOOL_CONTEXT, maxHistoryLimit: 2 });
    expect(times(await capped.history({ since: at(9), limit: 10 }))).toEqual([12, 11]);
    await expect(ctx.history({ since: at(9), limit: 0 })).rejects.toThrow(UserFacingError);
  });

  it("filters by flavor", async () => {
    const user = await newUser();
    await user.add(at(10), "classic_era", ZOELA);
    await user.add(at(11), "forever", BRANNIC);
    const ctx = await contextOf(user.uuid);

    expect((await ctx.latest({}))?.flavor).toBe("forever");
    expect((await ctx.latest({ flavor: "classic_era" }))?.snapshotAt).toEqual(at(10));
    expect((await ctx.history({ since: at(9), flavor: "classic_era", limit: 10 })).map((s) => s.flavor)).toEqual(["classic_era"]);
    expect(await ctx.latest({ flavor: "anniversary" })).toBeNull();
  });

  it("resolves a character by name or Name-Realm, case-insensitively", async () => {
    const user = await newUser();
    await user.add(at(10), "classic_era", ZOELA);
    await user.add(at(11), "classic_era", BRANNIC);
    const ctx = await contextOf(user.uuid);

    expect((await ctx.latest({ character: "zoela" }))?.character).toEqual(ZOELA);
    expect((await ctx.latest({ character: "BRANNIC-testrealm" }))?.character).toEqual(BRANNIC);
    expect((await ctx.history({ since: at(9), character: "ZOELA", limit: 10 })).map((s) => s.character)).toEqual([ZOELA]);
    await expect(ctx.latest({ character: "Zoela-Otherrealm" })).rejects.toThrow(UserFacingError);
    await expect(ctx.latest({ character: "Nobody" })).rejects.toThrow(UserFacingError);
  });

  it("compares realms as chat writes them: without whitespace, hyphens, and dots", async () => {
    const user = await newUser();
    const brannic = { ...BRANNIC, realm: "Living Flame" };
    const zoela = { ...ZOELA, realm: "Azjol-Nerub" };
    await user.add(at(10), "classic_era", brannic);
    await user.add(at(11), "classic_era", zoela);
    const ctx = await contextOf(user.uuid);

    expect((await ctx.latest({ character: "Brannic-LivingFlame" }))?.character).toEqual(brannic);
    expect((await ctx.latest({ character: "Brannic - Living Flame" }))?.character).toEqual(brannic);
    expect((await ctx.latest({ character: "Zoela-AzjolNerub" }))?.character).toEqual(zoela);
  });

  it("rejects an ambiguous name with the matches as Name-Realm", async () => {
    const user = await newUser();
    await user.add(at(10), "classic_era", ZOELA);
    await user.add(at(11), "forever", ZOELA_OTHER);
    const ctx = await contextOf(user.uuid);

    const err = await ctx.latest({ character: "zoela" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as Error).message).toContain("Zoela-Otherrealm (forever), Zoela-Testrealm (classic_era)");
    expect((await ctx.latest({ character: "zoela-otherrealm" }))?.character).toEqual(ZOELA_OTHER);
    // A flavor narrows the characters a name can match.
    expect((await ctx.latest({ character: "zoela", flavor: "classic_era" }))?.character).toEqual(ZOELA);
  });

  it("counts one Name-Realm in two flavors as two characters", async () => {
    const user = await newUser();
    const era = { ...ZOELA, realm: "Same" };
    const forever = { ...ZOELA_OTHER, realm: "Same" };
    await user.add(at(10), "classic_era", era);
    await user.add(at(11), "forever", forever);
    const ctx = await contextOf(user.uuid);

    await expect(ctx.latest({ character: "Zoela-Same" })).rejects.toThrow("Zoela-Same (forever), Zoela-Same (classic_era)");
    expect((await ctx.latest({ character: "Zoela-Same", flavor: "classic_era" }))?.character).toEqual(era);
  });

  it("never reads another user's snapshots", async () => {
    const a = await newUser();
    const b = await newUser();
    await a.add(at(10), "classic_era", ZOELA);
    await b.add(at(12), "classic_era", ZOELA_OTHER);
    await b.add(at(13), "classic_era", BRANNIC);
    const ctx = await contextOf(a.uuid);

    expect((await ctx.latest({}))?.snapshotAt).toEqual(at(10));
    expect((await ctx.history({ since: at(9), limit: 10 })).map((s) => s.character)).toEqual([ZOELA]);
    // B's Zoela makes no ambiguity for A, and B's Brannic is unknown to A.
    expect((await ctx.latest({ character: "Zoela" }))?.character).toEqual(ZOELA);
    await expect(ctx.latest({ character: "Brannic" })).rejects.toThrow(UserFacingError);
    expect(await findToolUser(pool, randomUUID())).toBeNull();
  });
});
