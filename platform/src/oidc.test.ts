import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { createOidcProvider } from "./oidc.js";
import { generateOidcKeys } from "./oidc-keys.js";
import { WebSessions } from "./web-sessions.js";

const ISSUER = "https://ogmcp.example";
const DAY_MS = 24 * 60 * 60 * 1000;

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

// No request here sends a cookie or reaches a model, so nothing queries the database.
async function serve(trustProxyHops: number): Promise<number> {
  const noDatabase = {} as Pool;
  const oidc = createOidcProvider({ pool: noDatabase, issuer: ISSUER, keys: generateOidcKeys(), trustProxyHops, log: () => {} });
  const sessions = new WebSessions({ pool: noDatabase, lifetimeMs: DAY_MS, renewWithinMs: DAY_MS, secure: true });
  const app = createApp({
    health: { checkDatabase: () => Promise.resolve() },
    auth: { pool: noDatabase, sessions, providers: { google: null, discord: null }, publicBaseUrl: ISSUER },
    oidc,
    trustProxyHops,
  });
  server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

/** A GET as Railway's edge forwards it: the public Host, and the client's protocol in X-Forwarded-Proto. */
async function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, headers: { host: "ogmcp.example", "x-forwarded-proto": "https", accept: "application/json" } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("OAuth server", () => {
  it("serves discovery with PUBLIC_BASE_URL as the issuer and https endpoints behind one trusted proxy", async () => {
    const port = await serve(1);
    const discovery = await get(port, "/.well-known/openid-configuration");
    expect(discovery.status).toBe(200);
    const metadata = JSON.parse(discovery.body) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      jwks_uri: `${ISSUER}/oauth/jwks`,
      code_challenge_methods_supported: ["S256"],
    });
    // Off until their own issues.
    expect(metadata["registration_endpoint"]).toBeUndefined();
    expect(metadata["device_authorization_endpoint"]).toBeUndefined();
    expect(metadata["client_id_metadata_document_supported"]).toBeUndefined();

    // The public halves only.
    const jwks = JSON.parse((await get(port, "/oauth/jwks")).body) as { keys: Record<string, unknown>[] };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: "RSA", use: "sig" });
    expect(jwks.keys[0]).not.toHaveProperty("d");

    // Express keeps its own routes: sign-in is not oidc-provider's /auth/:uid.
    expect((await get(port, "/auth/google")).body).toBe("Sign-in with Google is not configured on this server.");
    expect((await get(port, "/health/live")).status).toBe(200);
  });

  it("builds http endpoint URLs when no proxy is trusted, whatever X-Forwarded-Proto says", async () => {
    const port = await serve(0);
    const metadata = JSON.parse((await get(port, "/.well-known/openid-configuration")).body) as Record<string, unknown>;
    expect(metadata["issuer"]).toBe(ISSUER);
    expect(metadata["token_endpoint"]).toBe("http://ogmcp.example/oauth/token");
  });
});
