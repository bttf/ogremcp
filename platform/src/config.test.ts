import { describe, expect, it } from "vitest";

import { DEFAULT_CIMD_FETCH_LIMITS } from "./cimd.js";
import { DEFAULT_MISSES } from "./devices.js";
import {
  DEFAULT_DATABASE_QUERY_TIMEOUT_MS,
  DEFAULT_PORT,
  DEFAULT_TRUST_PROXY_HOPS,
  DEFAULT_WEB_SESSION_LIFETIME_DAYS,
  DEFAULT_WEB_SESSION_RENEW_WITHIN_DAYS,
  loadConfig,
} from "./config.js";
import { DEFAULT_INGEST } from "./ingest.js";
import { MCP_CLIENT_ORIGINS } from "./mcp.js";
import { formatOidcKeys, generateOidcKeys, resolveOidcKeys } from "./oidc-keys.js";
import { DEFAULT_REGISTRATION } from "./oidc-registration.js";
import { DEFAULT_TOKEN_LIFETIMES } from "./oidc-tokens.js";
import { DEFAULT_RETENTION } from "./retention.js";
import { DEFAULT_TOOL_CONTEXT } from "./tool-context.js";
import { NO_TOOL_CALL_CAPS } from "./usage.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const url = "postgresql://ogremcp:secret-password@localhost:5432/ogremcp";

describe("loadConfig", () => {
  it("reads PORT, DATABASE_URL, and DATABASE_QUERY_TIMEOUT_MS, with defaults", () => {
    expect(loadConfig({ DATABASE_URL: url })).toEqual({
      port: DEFAULT_PORT,
      databaseUrl: url,
      databaseQueryTimeoutMs: DEFAULT_DATABASE_QUERY_TIMEOUT_MS,
      publicBaseUrl: `http://localhost:${DEFAULT_PORT}`,
      trustProxyHops: DEFAULT_TRUST_PROXY_HOPS,
      mcpAllowedOrigins: [`http://localhost:${DEFAULT_PORT}`, ...MCP_CLIENT_ORIGINS],
      webSessionLifetimeMs: DEFAULT_WEB_SESSION_LIFETIME_DAYS * DAY_MS,
      webSessionRenewWithinMs: DEFAULT_WEB_SESSION_RENEW_WITHIN_DAYS * DAY_MS,
      registration: DEFAULT_REGISTRATION,
      google: null,
      discord: null,
      oidcKeys: null,
      tokenLifetimes: DEFAULT_TOKEN_LIFETIMES,
      cimdFetchLimits: DEFAULT_CIMD_FETCH_LIMITS,
      deviceCodeMisses: DEFAULT_MISSES,
      ingest: DEFAULT_INGEST,
      toolContext: DEFAULT_TOOL_CONTEXT,
      toolCallCaps: NO_TOOL_CALL_CAPS,
      retention: DEFAULT_RETENTION,
      bridgeDownloadUrl: null,
      contactEmail: null,
      adminUserUuids: [],
      logLevel: "info",
      production: false,
    });
    const config = loadConfig({ DATABASE_URL: url, PORT: "8080", DATABASE_QUERY_TIMEOUT_MS: "2500" });
    expect(config.port).toBe(8080);
    expect(config.databaseQueryTimeoutMs).toBe(2500);
  });

  it("reads MCP_ALLOWED_ORIGINS as exact origins that replace the default list", () => {
    const config = loadConfig({ DATABASE_URL: url, MCP_ALLOWED_ORIGINS: " https://claude.ai, http://localhost:6274 " });
    expect(config.mcpAllowedOrigins).toEqual(["https://claude.ai", "http://localhost:6274"]);
    for (const bad of ["*", "https://*.claude.ai", "https://claude.ai/", "https://Claude.ai", "claude.ai"]) {
      expect(() => loadConfig({ DATABASE_URL: url, MCP_ALLOWED_ORIGINS: bad })).toThrow("MCP_ALLOWED_ORIGINS must list origins only");
    }
  });

  it("refuses to start without DATABASE_URL", () => {
    expect(() => loadConfig({})).toThrow("DATABASE_URL must be set");
  });

  it("refuses a malformed DATABASE_URL without repeating it", () => {
    for (const bad of ["mysql://ogremcp:secret-password@localhost/ogremcp", "postgresql://ogremcp:secret-password@localhost", "secret-password"]) {
      let message = "";
      try {
        loadConfig({ DATABASE_URL: bad });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/^DATABASE_URL /);
      expect(message).not.toContain("secret-password");
    }
  });

  it("refuses a PORT that is not a port and a query timeout that is not positive", () => {
    expect(() => loadConfig({ DATABASE_URL: url, PORT: "http" })).toThrow("PORT must be");
    expect(() => loadConfig({ DATABASE_URL: url, DATABASE_QUERY_TIMEOUT_MS: "0" })).toThrow("DATABASE_QUERY_TIMEOUT_MS must be");
  });

  it("reads each sign-in provider as a pair, and then needs PUBLIC_BASE_URL", () => {
    const google = { GOOGLE_CLIENT_ID: "google-id", GOOGLE_CLIENT_SECRET: "google-client-secret" };
    const config = loadConfig({ DATABASE_URL: url, PUBLIC_BASE_URL: "https://ogremcp.example/", ...google });
    expect(config.google).toEqual({ clientId: "google-id", clientSecret: "google-client-secret" });
    expect(config.discord).toBeNull();
    expect(config.publicBaseUrl).toBe("https://ogremcp.example");

    expect(() => loadConfig({ DATABASE_URL: url, ...google })).toThrow("PUBLIC_BASE_URL must be set when a sign-in provider is configured");
    let message = "";
    try {
      loadConfig({ DATABASE_URL: url, PUBLIC_BASE_URL: "https://ogremcp.example", DISCORD_CLIENT_SECRET: "discord-client-secret" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe("DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET must be set together");
    expect(() => loadConfig({ DATABASE_URL: url, PUBLIC_BASE_URL: "https://ogremcp.example/app" })).toThrow("PUBLIC_BASE_URL must be an origin only");
  });

  it("refuses a renewal window longer than the web session lifetime", () => {
    expect(() => loadConfig({ DATABASE_URL: url, WEB_SESSION_LIFETIME_DAYS: "7", WEB_SESSION_RENEW_WITHIN_DAYS: "8" })).toThrow(
      "WEB_SESSION_RENEW_WITHIN_DAYS must not be more than WEB_SESSION_LIFETIME_DAYS",
    );
    expect(loadConfig({ DATABASE_URL: url, WEB_SESSION_LIFETIME_DAYS: "7" }).webSessionRenewWithinMs).toBe(7 * DAY_MS);
  });

  it("reads the OAuth token lifetimes, and refuses a refresh token that outlasts its grant", () => {
    const config = loadConfig({
      DATABASE_URL: url,
      OAUTH_ACCESS_TOKEN_LIFETIME_MINUTES: "15",
      OAUTH_REFRESH_TOKEN_LIFETIME_DAYS: "7",
      OAUTH_GRANT_LIFETIME_DAYS: "90",
    });
    expect(config.tokenLifetimes).toEqual({ accessTokenSeconds: 15 * 60, refreshTokenSeconds: 7 * 86_400, grantSeconds: 90 * 86_400 });
    expect(() => loadConfig({ DATABASE_URL: url, OAUTH_GRANT_LIFETIME_DAYS: "20" })).toThrow(
      "OAUTH_REFRESH_TOKEN_LIFETIME_DAYS must not be more than OAUTH_GRANT_LIFETIME_DAYS",
    );
  });

  it("reads DCR_TRUSTED_RANGES as CIDR ranges that replace the default", () => {
    const config = loadConfig({ DATABASE_URL: url, DCR_TRUSTED_RANGES: " 160.79.104.0/21, 2001:db8::/32 " });
    expect(config.registration.trustedRanges).toEqual([
      { address: "160.79.104.0", prefix: 21, family: "ipv4" },
      { address: "2001:db8::", prefix: 32, family: "ipv6" },
    ]);
    for (const bad of ["160.79.104.0", "160.79.104.0/33", "claude.ai/21", "160.79.104.0/21/1"]) {
      expect(() => loadConfig({ DATABASE_URL: url, DCR_TRUSTED_RANGES: bad })).toThrow("DCR_TRUSTED_RANGES must list address ranges only");
    }
  });

  it("reads CIMD_TRUSTED_CLIENT_IDS as exact URLs that replace the default list", () => {
    const ids = "https://claude.ai/oauth/mcp-oauth-client-metadata, https://agent.example/client.json";
    expect(loadConfig({ DATABASE_URL: url, CIMD_TRUSTED_CLIENT_IDS: ids }).cimdFetchLimits.trustedClientIds).toEqual([
      "https://claude.ai/oauth/mcp-oauth-client-metadata",
      "https://agent.example/client.json",
    ]);
    expect(() => loadConfig({ DATABASE_URL: url, CIMD_TRUSTED_CLIENT_IDS: "https://CLAUDE.ai/x" })).toThrow("CIMD_TRUSTED_CLIENT_IDS must list");
  });

  it("reads the daily tool-call caps per tier, each unset being no cap and each at most a Postgres integer (§14)", () => {
    expect(loadConfig({ DATABASE_URL: url, TOOL_CALLS_PER_DAY_FREE: "50" }).toolCallCaps).toEqual({ free: 50, paid: null });
    expect(() => loadConfig({ DATABASE_URL: url, TOOL_CALLS_PER_DAY_PAID: "0" })).toThrow("TOOL_CALLS_PER_DAY_PAID must be a whole number of 1 or more");
    expect(() => loadConfig({ DATABASE_URL: url, TOOL_CALLS_PER_DAY_FREE: "2147483648" })).toThrow("TOOL_CALLS_PER_DAY_FREE must be at most 2147483647");
  });

  it("reads off or 0 as no limit for FREE_RETENTION_DAYS and DEVICES_PER_USER_FREE, and bounds the retention days (§11, §14)", () => {
    const off = loadConfig({ DATABASE_URL: url, FREE_RETENTION_DAYS: "off", DEVICES_PER_USER_FREE: " OFF " });
    expect(off.retention.freeRetentionDays).toBeNull();
    expect(off.ingest.devicesPerUser.free).toBeNull();
    expect(loadConfig({ DATABASE_URL: url, FREE_RETENTION_DAYS: "0", DEVICES_PER_USER_FREE: "0" }).ingest.devicesPerUser.free).toBeNull();
    expect(loadConfig({ DATABASE_URL: url, FREE_RETENTION_DAYS: "36500" }).retention.freeRetentionDays).toBe(36500);
    expect(() => loadConfig({ DATABASE_URL: url, FREE_RETENTION_DAYS: "36501" })).toThrow("FREE_RETENTION_DAYS must be off or a whole number from 1 to 36500");
    expect(() => loadConfig({ DATABASE_URL: url, DOWNGRADE_GRACE_DAYS: "36501" })).toThrow("DOWNGRADE_GRACE_DAYS must be at most 36500");
    expect(() => loadConfig({ DATABASE_URL: url, DEVICES_PER_USER_FREE: "none" })).toThrow("DEVICES_PER_USER_FREE must be off or a whole number");
  });

  it("reads BRIDGE_DOWNLOAD_URL as an https URL", () => {
    const config = loadConfig({ DATABASE_URL: url, BRIDGE_DOWNLOAD_URL: " https://downloads.example/ogremcp-bridge " });
    expect(config.bridgeDownloadUrl).toBe("https://downloads.example/ogremcp-bridge");
    for (const bad of ["javascript:alert(1)", "http://downloads.example/ogremcp-bridge", "downloads.example"]) {
      expect(() => loadConfig({ DATABASE_URL: url, BRIDGE_DOWNLOAD_URL: bad })).toThrow("BRIDGE_DOWNLOAD_URL must be an https URL");
    }
  });

  it("reads CONTACT_EMAIL as a plain email address", () => {
    expect(loadConfig({ DATABASE_URL: url, CONTACT_EMAIL: " privacy@ogremcp.example " }).contactEmail).toBe("privacy@ogremcp.example");
    for (const bad of ["privacy", "privacy@example", "a b@example.com", "privacy@example.com?subject=x", "javascript:alert(1)@x.com"]) {
      expect(() => loadConfig({ DATABASE_URL: url, CONTACT_EMAIL: bad })).toThrow("CONTACT_EMAIL must be an email address");
    }
  });

  it("reads ADMIN_USER_UUIDS as user uuids in lower case", () => {
    const config = loadConfig({
      DATABASE_URL: url,
      ADMIN_USER_UUIDS: " 0B3D5E0A-7C1F-4E2B-9A6D-1F2E3D4C5B6A, 5f1e2d3c-4b5a-4968-8776-655443322110 ",
    });
    expect(config.adminUserUuids).toEqual(["0b3d5e0a-7c1f-4e2b-9a6d-1f2e3d4c5b6a", "5f1e2d3c-4b5a-4968-8776-655443322110"]);
    expect(() => loadConfig({ DATABASE_URL: url, ADMIN_USER_UUIDS: "admin" })).toThrow("ADMIN_USER_UUIDS must list user uuids, comma-separated");
  });

  it("reads the OAuth server's keys as a pair, and never repeats one in an error", () => {
    const generated = generateOidcKeys();
    const lines = Object.fromEntries(
      formatOidcKeys(generated)
        .trim()
        .split("\n")
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    expect(Object.keys(lines)).toEqual(["OIDC_JWKS", "OIDC_COOKIE_KEYS"]);
    expect(loadConfig({ DATABASE_URL: url, ...lines }).oidcKeys).toEqual(generated);

    // Low entropy, so that the secret scan does not take it for a key.
    const secret = "MATERIAL".repeat(5);
    const privateKey = JSON.stringify({ keys: [{ kty: "RSA", n: secret, e: "AQAB", d: secret }] });
    const publicKey = JSON.stringify({ keys: [{ kty: "RSA", n: secret, e: "AQAB" }] });
    for (const [env, expected] of [
      [{ OIDC_JWKS: privateKey }, "OIDC_JWKS and OIDC_COOKIE_KEYS must be set together"],
      [{ OIDC_JWKS: `{${secret}`, OIDC_COOKIE_KEYS: secret }, "OIDC_JWKS is not valid JSON"],
      [{ OIDC_JWKS: publicKey, OIDC_COOKIE_KEYS: secret }, "OIDC_JWKS key 0 must be a private key"],
      [{ OIDC_JWKS: privateKey, OIDC_COOKIE_KEYS: `${secret},short-${secret.slice(0, 8)}` }, "each OIDC_COOKIE_KEYS key must be at least 32 characters"],
    ] as const) {
      let message = "";
      try {
        loadConfig({ DATABASE_URL: url, ...env });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toBe(expected);
    }
  });

  it("makes OAuth keys at start only on a local run", () => {
    expect(resolveOidcKeys(null, "http://localhost:4790", false).ephemeral).toBe(true);
    for (const [base, production] of [
      ["http://localhost:4790", true],
      ["https://ogremcp.example", false],
      ["http://ogremcp.example", false],
    ] as const) {
      expect(() => resolveOidcKeys(null, base, production)).toThrow(/^OIDC_JWKS and OIDC_COOKIE_KEYS must be set/);
    }
    const configured = generateOidcKeys();
    expect(resolveOidcKeys(configured, "https://ogremcp.example", true)).toEqual({ keys: configured, ephemeral: false });
  });
});
