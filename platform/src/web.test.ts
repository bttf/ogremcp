import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { HSTS } from "./security-headers.js";
import { WEB_HEADERS } from "./web.js";
import { WebSessions } from "./web-sessions.js";

const PAGE = "<!doctype html><title>web</title>";
const HTML = { accept: "text/html,application/xhtml+xml,*/*;q=0.8" };

let server: Server | undefined;
let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "ogremcp-web-"));
  writeFileSync(join(webRoot, "index.html"), PAGE);
  mkdirSync(join(webRoot, "assets"));
  writeFileSync(join(webRoot, "assets", "index-abc123.js"), "export {};");
});

afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

afterEach(() => {
  server?.close();
  server = undefined;
});

describe("the web UI", () => {
  it("serves its files and page loads with the security headers, and leaves the service's paths to their routes", async () => {
    // No cookie is sent, so nothing queries the database.
    const pool = {} as Pool;
    const sessions = new WebSessions({ pool, lifetimeMs: 1, renewWithinMs: 1, secure: false });
    const auth = { pool, sessions, providers: { google: null, discord: null }, publicBaseUrl: "http://localhost:4790" };
    server = createServer(createApp({ health: { checkDatabase: () => Promise.resolve() }, auth, webRoot })).listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    for (const path of ["/", "/signin", "/no/such/page"]) {
      const res = await fetch(`${base}${path}`, { headers: HTML });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(PAGE);
      for (const [name, value] of Object.entries(WEB_HEADERS)) expect(res.headers.get(name)).toBe(value);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("private, no-cache");
    }
    expect(WEB_HEADERS["Content-Security-Policy"]).not.toContain("unsafe-inline");

    const asset = await fetch(`${base}/assets/index-abc123.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-security-policy")).toBe(WEB_HEADERS["Content-Security-Policy"]);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    // A page load of a service path goes to its route, not to the web app.
    const signIn = await fetch(`${base}/auth/google`, { headers: HTML, redirect: "manual" });
    expect(signIn.status).toBe(503);
    expect((await fetch(`${base}/oauth/auth`, { headers: HTML })).status).toBe(404);
    const unknownApi = await fetch(`${base}/api/v1/nothing`, { headers: HTML });
    expect(unknownApi.status).toBe(404);
    expect(await unknownApi.json()).toEqual({ error: "not_found" });
    expect((await fetch(`${base}/health/live`, { headers: HTML })).headers.get("content-type")).toMatch(/^application\/json/);

    // A request that is not a page load gets no page.
    expect((await fetch(`${base}/signin`)).status).toBe(404);
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    // Plain http: no HSTS.
    expect((await fetch(`${base}/`, { headers: HTML })).headers.get("strict-transport-security")).toBeNull();
  });

  it("sends HSTS on every response when PUBLIC_BASE_URL is https", async () => {
    server = createServer(createApp({ health: { checkDatabase: () => Promise.resolve() }, webRoot, https: true })).listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const [path, headers] of [["/health/live", {}], ["/", HTML], ["/assets/index-abc123.js", {}], ["/no/such/file.txt", {}]] as const) {
      expect((await fetch(`${base}${path}`, { headers })).headers.get("strict-transport-security")).toBe(HSTS);
    }
  });
});
