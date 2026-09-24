import express, { type RequestHandler, type Response, type Router } from "express";
import type Provider from "oidc-provider";

import { requireToken, resourcesOf } from "./oidc-tokens.js";

/**
 * Discovery for the MCP endpoint and the checks in front of it (§9).
 *
 * - `GET /.well-known/oauth-protected-resource/mcp` and
 *   `GET /.well-known/oauth-protected-resource`: the Protected Resource
 *   Metadata (RFC 9728) of the resource `<PUBLIC_BASE_URL>/mcp`. It names the
 *   OAuth server's issuer as the authorization server. The first path is the
 *   one RFC 9728 §3.1 derives from the resource, and the one the 401 names;
 *   MCP clients that probe fall back to the second. Both are public and sent
 *   with CORS, so that a browser-based client can read them.
 * - `/mcp`: the `Host` must name `PUBLIC_BASE_URL`'s host, and an `Origin`,
 *   when sent, must be one of `MCP_ALLOWED_ORIGINS`, which blocks DNS
 *   rebinding. Then the access token must be for this resource and carry
 *   `read` (`requireToken`). A request without one gets 401 with the
 *   challenge of RFC 9728 §5.1, which points at the metadata.
 *
 * The OAuth server's own metadata, at `/.well-known/openid-configuration` and
 * `/.well-known/oauth-authorization-server`, is oidc-provider's (`oidc.ts`).
 *
 * The MCP server itself is RED-325. Until then, a request with a valid token
 * gets 501.
 *
 * Adapted from `cloud/src/mcp.ts` in bttf/wow-guide@df80260.
 */

/** The MCP endpoint (§9). Every agent uses this one URL. */
export const MCP_PATH = "/mcp";

/** The root form of the Protected Resource Metadata path (RFC 9728 §3). */
export const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

/** The metadata path of the resource `<origin>/mcp` (RFC 9728 §3.1). The 401 names this one. */
export const MCP_RESOURCE_METADATA_PATH = `${RESOURCE_METADATA_PATH}${MCP_PATH}`;

/** Agents get `read`, which covers every v1 MCP tool (§9). */
export const MCP_SCOPES = ["read"] as const;

/**
 * The web origins of the §9 target clients. Their requests to `/mcp` can
 * carry them as `Origin`: the claude.ai connector sends
 * `Origin: https://claude.ai`, and ChatGPT's web app sends its own.
 */
export const MCP_CLIENT_ORIGINS: readonly string[] = [
  "https://claude.ai",
  "https://chatgpt.com",
  "https://chat.openai.com",
  "https://www.perplexity.ai",
  "https://perplexity.ai",
];

/** `MCP_ALLOWED_ORIGINS` when it is unset: `PUBLIC_BASE_URL` and `MCP_CLIENT_ORIGINS`. */
export function defaultMcpAllowedOrigins(publicBaseUrl: string): string[] {
  return [new URL(publicBaseUrl).origin, ...MCP_CLIENT_ORIGINS];
}

export interface McpOptions {
  /** `PUBLIC_BASE_URL`. The resource is `<it>/mcp`, and the Host check compares against it. */
  publicBaseUrl: string;
  /** The OAuth server: its issuer is the one authorization server of the resource, and it holds the access tokens. */
  provider: Provider;
  /**
   * `MCP_ALLOWED_ORIGINS`: the values `Origin` may have on `/mcp`, each an
   * exact origin. Default: `defaultMcpAllowedOrigins(publicBaseUrl)`.
   */
  allowedOrigins?: readonly string[];
}

/** The resource identifier of the MCP endpoint (RFC 8707, RFC 9728): what tokens for it are asked for. */
export function mcpResource(publicBaseUrl: string): string {
  return resourcesOf(new URL(publicBaseUrl).origin).mcp;
}

/** The Protected Resource Metadata document of the MCP endpoint (RFC 9728 §2). */
function resourceMetadata({ publicBaseUrl, provider }: Pick<McpOptions, "publicBaseUrl" | "provider">) {
  return {
    resource: mcpResource(publicBaseUrl),
    authorization_servers: [provider.issuer],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ["header"],
  };
}

function sendRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

export function mcpRouter(options: McpOptions): Router {
  const router = express.Router();
  const base = new URL(options.publicBaseUrl);
  const metadataUrl = `${base.origin}${MCP_RESOURCE_METADATA_PATH}`;
  const metadata = resourceMetadata(options);
  const allowedOrigins = new Set(options.allowedOrigins ?? defaultMcpAllowedOrigins(options.publicBaseUrl));

  // The metadata holds no secret. `*` lets any page read it.
  const sendMetadata: RequestHandler = (_req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.json(metadata);
  };
  // MCP clients send `MCP-Protocol-Version` with the request, which makes a
  // browser ask first. As oidc-provider does for its own metadata, the
  // headers asked for are allowed.
  const preflight: RequestHandler = (req, res) => {
    res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET" });
    const headers = req.get("access-control-request-headers");
    if (headers !== undefined) res.set("Access-Control-Allow-Headers", headers);
    res.status(204).end();
  };
  for (const path of [MCP_RESOURCE_METADATA_PATH, RESOURCE_METADATA_PATH]) {
    router.get(path, sendMetadata);
    router.options(path, preflight);
  }

  // DNS rebinding protection, as the MCP SDK's `hostHeaderValidation`: the
  // hostname of `Host`, whatever its port, must be the service's. The message
  // does not repeat the header.
  const checkHost: RequestHandler = (req, res, next) => {
    let hostname: string | null = null;
    try {
      if (req.headers.host !== undefined) hostname = new URL(`http://${req.headers.host}`).hostname;
    } catch {
      // Not a host: refused below.
    }
    if (hostname === base.hostname) return next();
    sendRpcError(res, 403, -32000, "Invalid Host header");
  };

  // A page on an origin not in the list cannot call the endpoint, whatever
  // host name it used to reach it. The match is exact: scheme, host, and
  // port. A request without `Origin` passes: browsers send it, and most MCP
  // clients are not browsers. No CORS header is sent.
  const checkOrigin: RequestHandler = (req, res, next) => {
    const origin = req.get("origin");
    if (origin === undefined || allowedOrigins.has(origin)) return next();
    sendRpcError(res, 403, -32000, "Origin not allowed");
  };

  // Its challenges carry RFC 9728 §5.1's pointer to the metadata, and the
  // scope an agent needs (MCP 2025-11-25, Scope Selection Strategy).
  const requireRead = requireToken({
    provider: options.provider,
    resource: mcpResource(options.publicBaseUrl),
    scope: "read",
    challenge: { resource_metadata: metadataUrl },
  });

  // RED-325 serves MCP here.
  const notImplemented: RequestHandler = (_req, res) => {
    sendRpcError(res, 501, -32000, "Not implemented yet");
  };

  router.all(MCP_PATH, checkHost, checkOrigin, requireRead, notImplemented);
  return router;
}
