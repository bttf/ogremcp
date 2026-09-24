import { describe, expect, it } from "vitest";

import { DEFAULT_DATABASE_QUERY_TIMEOUT_MS, DEFAULT_PORT, loadConfig } from "./config.js";

const url = "postgresql://ogmcp:secret-password@localhost:5432/ogmcp";

describe("loadConfig", () => {
  it("reads PORT, DATABASE_URL, and DATABASE_QUERY_TIMEOUT_MS, with defaults", () => {
    expect(loadConfig({ DATABASE_URL: url })).toEqual({
      port: DEFAULT_PORT,
      databaseUrl: url,
      databaseQueryTimeoutMs: DEFAULT_DATABASE_QUERY_TIMEOUT_MS,
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
});
