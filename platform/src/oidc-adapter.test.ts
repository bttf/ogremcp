import { randomBytes } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool } from "./db.js";
import { migrate } from "./migrations.js";
import { PostgresAdapter } from "./oidc-adapter.js";

/** As in migrations.test.ts: a Postgres server whose user may create databases. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"]?.trim() || undefined;
if (TEST_DATABASE_URL === undefined) console.warn("TEST_DATABASE_URL is not set: the Postgres tests in oidc-adapter.test.ts are skipped");

describe.skipIf(TEST_DATABASE_URL === undefined)("PostgresAdapter against Postgres", () => {
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

  it("stores, finds, replaces, consumes, and destroys a model's rows, apart from other models", async () => {
    const codes = new PostgresAdapter(pool, "AuthorizationCode");
    const tokens = new PostgresAdapter(pool, "AccessToken");
    await codes.upsert("same-id", { jti: "same-id", kind: "AuthorizationCode", grantId: "g1" }, 60);
    await tokens.upsert("same-id", { jti: "same-id", kind: "AccessToken", grantId: "g1" }, 60);
    expect(await codes.find("same-id")).toEqual({ jti: "same-id", kind: "AuthorizationCode", grantId: "g1" });
    expect(await codes.find("other-id")).toBeUndefined();

    await codes.upsert("same-id", { jti: "same-id", kind: "AuthorizationCode", grantId: "g1", scope: "openid" }, 60);
    expect(await codes.find("same-id")).toMatchObject({ scope: "openid" });

    const before = Math.floor(Date.now() / 1000);
    await codes.consume("same-id");
    const consumed = (await codes.find("same-id"))?.consumed as number;
    expect(consumed).toBeGreaterThanOrEqual(before - 1);
    expect(consumed).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);
    expect((await tokens.find("same-id"))?.consumed).toBeUndefined();

    await codes.destroy("same-id");
    expect(await codes.find("same-id")).toBeUndefined();
    expect(await tokens.find("same-id")).toBeDefined();
  });

  it("finds a session by uid and a device code by user code, and keeps a row without expiry", async () => {
    const sessions = new PostgresAdapter(pool, "Session");
    await sessions.upsert("session-1", { jti: "session-1", uid: "uid-1", accountId: "a" }, 600);
    expect(await sessions.findByUid("uid-1")).toMatchObject({ jti: "session-1", accountId: "a" });
    expect(await sessions.findByUid("uid-2")).toBeUndefined();

    const deviceCodes = new PostgresAdapter(pool, "DeviceCode");
    await deviceCodes.upsert("device-1", { jti: "device-1", userCode: "BCDF-GHJK" }, 600);
    expect(await deviceCodes.findByUserCode("BCDF-GHJK")).toMatchObject({ jti: "device-1" });

    const clients = new PostgresAdapter(pool, "Client");
    await clients.upsert("client-1", { client_id: "client-1", redirect_uris: ["https://agent.example/cb"] });
    expect(await clients.find("client-1")).toEqual({ client_id: "client-1", redirect_uris: ["https://agent.example/cb"] });
    const { rows } = await pool.query("select expires_at from oidc_models where model = 'Client' and oidc_id = 'client-1'");
    expect(rows).toEqual([{ expires_at: null }]);
  });

  it("returns nothing past the expiry", async () => {
    const tokens = new PostgresAdapter(pool, "AccessToken");
    await tokens.upsert("expired", { jti: "expired" }, 60);
    await pool.query("update oidc_models set expires_at = now() - interval '1 second' where oidc_id = 'expired'");
    expect(await tokens.find("expired")).toBeUndefined();
  });

  it("revokes a grant's rows of one model and leaves other grants and models", async () => {
    const tokens = new PostgresAdapter(pool, "RefreshToken");
    const interactions = new PostgresAdapter(pool, "Interaction");
    await tokens.upsert("rt-1", { jti: "rt-1", grantId: "grant-a" }, 600);
    await tokens.upsert("rt-2", { jti: "rt-2", grantId: "grant-a" }, 600);
    await tokens.upsert("rt-3", { jti: "rt-3", grantId: "grant-b" }, 600);
    await interactions.upsert("int-1", { jti: "int-1", grantId: "grant-a" }, 600);

    await tokens.revokeByGrantId("grant-a");
    expect(await tokens.find("rt-1")).toBeUndefined();
    expect(await tokens.find("rt-2")).toBeUndefined();
    expect(await tokens.find("rt-3")).toBeDefined();
    expect(await interactions.find("int-1")).toBeDefined();
  });
});
