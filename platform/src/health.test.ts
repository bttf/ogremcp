import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "./app.js";
import type { HealthOptions } from "./health.js";

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

/** Serves the app on a free port with a mocked database check. */
async function serve(options: HealthOptions): Promise<string> {
  server = createServer(createApp({ health: options })).listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("health", () => {
  it("answers /health/live without touching the database", async () => {
    const checkDatabase = vi.fn(() => Promise.reject(new Error("down")));
    const base = await serve({ checkDatabase });
    const res = await fetch(`${base}/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(checkDatabase).not.toHaveBeenCalled();
  });

  it("answers /health with ok when the database answers", async () => {
    const base = await serve({ checkDatabase: () => Promise.resolve() });
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("answers /health with 503 and no reason when the database fails", async () => {
    const base = await serve({ checkDatabase: () => Promise.reject(new Error("password authentication failed")) });
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "degraded" });
  });

  it("answers /health with 503 when the database is slower than the timeout", async () => {
    const base = await serve({ checkDatabase: () => new Promise(() => {}), timeoutMs: 50 });
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "degraded" });
  });
});
