import { describe, expect, it } from "vitest";

import { DEFAULT_PORT, loadConfig } from "./config.js";

const url = "postgresql://ogmcp:secret-password@localhost:5432/ogmcp";

describe("loadConfig", () => {
  it("reads PORT and DATABASE_URL, with a default port", () => {
    expect(loadConfig({ DATABASE_URL: url })).toEqual({ port: DEFAULT_PORT, databaseUrl: url });
    expect(loadConfig({ DATABASE_URL: url, PORT: "8080" }).port).toBe(8080);
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

  it("refuses a PORT that is not a port", () => {
    expect(() => loadConfig({ DATABASE_URL: url, PORT: "http" })).toThrow("PORT must be");
  });
});
