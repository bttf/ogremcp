import { describe, expect, it } from "vitest";

import {
  DEFAULT_DATABASE_QUERY_TIMEOUT_MS,
  DEFAULT_PORT,
  DEFAULT_TRUST_PROXY_HOPS,
  DEFAULT_WEB_SESSION_LIFETIME_DAYS,
  DEFAULT_WEB_SESSION_RENEW_WITHIN_DAYS,
  loadConfig,
} from "./config.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const url = "postgresql://ogmcp:secret-password@localhost:5432/ogmcp";

describe("loadConfig", () => {
  it("reads PORT, DATABASE_URL, and DATABASE_QUERY_TIMEOUT_MS, with defaults", () => {
    expect(loadConfig({ DATABASE_URL: url })).toEqual({
      port: DEFAULT_PORT,
      databaseUrl: url,
      databaseQueryTimeoutMs: DEFAULT_DATABASE_QUERY_TIMEOUT_MS,
      publicBaseUrl: `http://localhost:${DEFAULT_PORT}`,
      trustProxyHops: DEFAULT_TRUST_PROXY_HOPS,
      webSessionLifetimeMs: DEFAULT_WEB_SESSION_LIFETIME_DAYS * DAY_MS,
      webSessionRenewWithinMs: DEFAULT_WEB_SESSION_RENEW_WITHIN_DAYS * DAY_MS,
      google: null,
      discord: null,
    });
    const config = loadConfig({ DATABASE_URL: url, PORT: "8080", DATABASE_QUERY_TIMEOUT_MS: "2500" });
    expect(config.port).toBe(8080);
    expect(config.databaseQueryTimeoutMs).toBe(2500);
  });

  it("refuses to start without DATABASE_URL", () => {
    expect(() => loadConfig({})).toThrow("DATABASE_URL must be set");
  });

  it("refuses a malformed DATABASE_URL without repeating it", () => {
    for (const bad of ["mysql://ogmcp:secret-password@localhost/ogmcp", "postgresql://ogmcp:secret-password@localhost", "secret-password"]) {
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
    const config = loadConfig({ DATABASE_URL: url, PUBLIC_BASE_URL: "https://ogmcp.example/", ...google });
    expect(config.google).toEqual({ clientId: "google-id", clientSecret: "google-client-secret" });
    expect(config.discord).toBeNull();
    expect(config.publicBaseUrl).toBe("https://ogmcp.example");

    expect(() => loadConfig({ DATABASE_URL: url, ...google })).toThrow("PUBLIC_BASE_URL must be set when a sign-in provider is configured");
    let message = "";
    try {
      loadConfig({ DATABASE_URL: url, PUBLIC_BASE_URL: "https://ogmcp.example", DISCORD_CLIENT_SECRET: "discord-client-secret" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe("DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET must be set together");
    expect(() => loadConfig({ DATABASE_URL: url, PUBLIC_BASE_URL: "https://ogmcp.example/app" })).toThrow("PUBLIC_BASE_URL must be an origin only");
  });

  it("refuses a renewal window longer than the web session lifetime", () => {
    expect(() => loadConfig({ DATABASE_URL: url, WEB_SESSION_LIFETIME_DAYS: "7", WEB_SESSION_RENEW_WITHIN_DAYS: "8" })).toThrow(
      "WEB_SESSION_RENEW_WITHIN_DAYS must not be more than WEB_SESSION_LIFETIME_DAYS",
    );
    expect(loadConfig({ DATABASE_URL: url, WEB_SESSION_LIFETIME_DAYS: "7" }).webSessionRenewWithinMs).toBe(7 * DAY_MS);
  });
});
