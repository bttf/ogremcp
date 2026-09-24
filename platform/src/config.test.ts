import { describe, expect, it } from "vitest";

import {
  DEFAULT_DATABASE_QUERY_TIMEOUT_MS,
  DEFAULT_PORT,
  DEFAULT_TRUST_PROXY_HOPS,
  DEFAULT_WEB_SESSION_LIFETIME_DAYS,
  DEFAULT_WEB_SESSION_RENEW_WITHIN_DAYS,
  loadConfig,
} from "./config.js";
import { formatOidcKeys, generateOidcKeys, resolveOidcKeys } from "./oidc-keys.js";

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
      oidcKeys: null,
      production: false,
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
      ["https://ogmcp.example", false],
      ["http://ogmcp.example", false],
    ] as const) {
      expect(() => resolveOidcKeys(null, base, production)).toThrow(/^OIDC_JWKS and OIDC_COOKIE_KEYS must be set/);
    }
    const configured = generateOidcKeys();
    expect(resolveOidcKeys(configured, "https://ogmcp.example", true)).toEqual({ keys: configured, ephemeral: false });
  });
});
