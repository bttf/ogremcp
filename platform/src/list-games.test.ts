import { randomBytes } from "node:crypto";

import type { Character } from "@ogmcp/sdk";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool } from "./db.js";
import type { Kit } from "./kits/registry.js";
import { listGames, NO_GAMES_NOTE, NO_SNAPSHOT_NOTE, SETUP_STEPS } from "./list-games.js";
import { migrate } from "./migrations.js";
import { DEFAULT_TOOL_CONTEXT, findToolUser } from "./tool-context.js";

/** As in migrations.test.ts: a Postgres server whose user may create databases. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"]?.trim() || undefined;
if (TEST_DATABASE_URL === undefined) console.warn("TEST_DATABASE_URL is not set: the Postgres tests in list-games.test.ts are skipped");

const WOW = { key: "wow", name: "World of Warcraft" } as Kit;

const ZOELA: Character = { key: "Player-0000-00000001", name: "Zoela", realm: "Testrealm" };
const BRANNIC: Character = { key: "Player-0000-00000002", name: "Brannic", realm: "Testrealm" };

function at(hour: number): Date {
  return new Date(Date.UTC(2026, 8, 24, hour));
}

describe.skipIf(TEST_DATABASE_URL === undefined)("list_games (§10.3)", () => {
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

  /** A new user with a device, and a function that stores one WoW snapshot of theirs. */
  async function newUser(): Promise<{ uuid: string; add(snapshotAt: Date, flavor: string, character: Character): Promise<void> }> {
    const { rows: users } = await pool.query<{ id: string; uuid: string }>("insert into users default values returning id, uuid");
    const user = users[0];
    if (user === undefined) throw new Error("no user row");
    const { rows: devices } = await pool.query<{ id: string }>("insert into devices (user_id) values ($1) returning id", [user.id]);
    return {
      uuid: user.uuid,
      async add(snapshotAt, flavor, character) {
        const hex = () => randomBytes(32).toString("hex");
        const { rows } = await pool.query<{ id: string }>(
          `insert into uploads (user_id, device_id, kit, source_id, instance, sha256, content_gzip, kit_version, adapter_schema, parse_status)
           values ($1, $2, 'wow', 'savedvariables', $3, $4, '\\x00', '0.1.0', 1, 'parsed') returning id`,
          [user.id, devices[0]?.id, hex(), hex()],
        );
        await pool.query(
          `insert into snapshots (user_id, upload_id, kit, flavor, rules, character_key, character_name, character_realm, snapshot_at, state)
           values ($1, $2, 'wow', $3, '{}', $4, $5, $6, $7, '{}')`,
          [user.id, rows[0]?.id, flavor, character.key, character.name, character.realm, snapshotAt],
        );
      },
    };
  }

  /** `list_games` for the user with this uuid, with these games enabled. */
  async function call(uuid: string, games: readonly Kit[], settings = DEFAULT_TOOL_CONTEXT) {
    const user = await findToolUser(pool, uuid);
    if (user === null) throw new Error("no user");
    const result = await listGames.handler({}, { pool, user, games, settings, search: null, fetchPage: null, event: {} });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(result.structuredContent);
    return result.structuredContent;
  }

  it("returns the last-active game and flavor and the recent characters, of this user only", async () => {
    const user = await newUser();
    await user.add(at(10), "classic_era", ZOELA);
    await user.add(at(11), "forever", BRANNIC);
    await user.add(at(12), "classic_era", BRANNIC);
    // Arrives late: an offline upload of an older capture.
    await user.add(at(9), "forever", ZOELA);
    // Renamed since: the latest snapshot's name shows.
    await user.add(at(13), "classic_era", { ...ZOELA, name: "Zoelia" });
    const other = await newUser();
    await other.add(at(14), "forever", { key: "Player-0000-00000009", name: "Other", realm: "Testrealm" });

    const wow = (snapshotAt: Date, flavor: string, { name, realm }: Character) => ({ name, realm, flavor, snapshot_at: snapshotAt.toISOString() });
    expect(await call(user.uuid, [WOW])).toEqual({
      games: [
        {
          game: "wow",
          name: "World of Warcraft",
          active_flavor: "classic_era",
          snapshot_at: at(13).toISOString(),
          characters: [
            wow(at(13), "classic_era", { ...ZOELA, name: "Zoelia" }),
            wow(at(12), "classic_era", BRANNIC),
            wow(at(11), "forever", BRANNIC),
            wow(at(9), "forever", ZOELA),
          ],
        },
      ],
      last_active: { game: "wow", flavor: "classic_era", snapshot_at: at(13).toISOString() },
    });

    const capped = await call(user.uuid, [WOW], { ...DEFAULT_TOOL_CONTEXT, listGamesCharacters: 2 });
    expect((capped?.["games"] as { characters: unknown[] }[])[0]?.characters).toHaveLength(2);
  });

  it("returns the setup steps when no enabled game has a snapshot, and points to the Games page when no game is enabled", async () => {
    const user = await newUser();
    expect(await call(user.uuid, [WOW])).toEqual({
      games: [{ game: "wow", name: "World of Warcraft", active_flavor: null, snapshot_at: null, characters: [] }],
      last_active: null,
      note: NO_SNAPSHOT_NOTE,
      setup: SETUP_STEPS,
    });

    // A snapshot of a game the user has since disabled.
    await user.add(at(10), "classic_era", ZOELA);
    expect(await call(user.uuid, [])).toEqual({ games: [], last_active: null, note: NO_GAMES_NOTE, setup: SETUP_STEPS });
    expect(NO_GAMES_NOTE).toMatch(/Games page/);
  });
});
