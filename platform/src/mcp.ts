import { readFileSync } from "node:fs";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import express, { type ErrorRequestHandler, type Request, type RequestHandler, type Response, type Router } from "express";
import type Provider from "oidc-provider";

import { failureCode } from "./db.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { logger } from "./log.js";
import { currentToken, requireToken, resourcesOf, type VerifiedToken } from "./oidc-tokens.js";
import type { ToolRegistry } from "./tools.js";

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
 * - Then MCP Streamable HTTP, stateless (§9, D12). Each POST gets a new
 *   server and a new transport, and one JSON body back. There is no
 *   `Mcp-Session-Id` and no stream, so no `notifications/tools/list_changed`.
 *   GET, which would open a stream, and DELETE, which would end a session,
 *   get 405, as does every method other than POST. The body is at most
 *   `MAX_MCP_BODY_BYTES`. Every error on the route is a JSON-RPC error.
 * - A POST past the token check that gets a 4xx is logged, with the fixed
 *   text of the refusal and nothing of the request but its MCP method and
 *   `MCP-Protocol-Version` (`logRefusal`).
 * - `tools/list` and `tools/call` serve the tools of the token's user, from
 *   the tool registry (`tools.ts`, §10). A call's events row names the
 *   token's OAuth client as the agent client (§16).
 *
 * The OAuth server's own metadata, at `/.well-known/openid-configuration` and
 * `/.well-known/oauth-authorization-server`, is oidc-provider's (`oidc.ts`).
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

/** The largest request body on `/mcp`, in bytes. A request to this server is a few hundred bytes. */
export const MAX_MCP_BODY_BYTES = 64 * 1024;

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
  /** The tools `tools/list` lists and `tools/call` calls (§10). */
  tools: ToolRegistry;
  /** Receives one line per request that failed with an error. Default: `logger.error`. */
  log?: (line: string) => void;
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

/** The client-to-server methods of MCP 2025-11-25 and 2026-07-28: the ones a refusal's log line names. */
const LOGGED_METHODS: ReadonlySet<string> = new Set([
  "initialize",
  "notifications/initialized",
  "server/discover",
  "ping",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "resources/subscribe",
  "resources/unsubscribe",
  "subscriptions/listen",
  "prompts/list",
  "prompts/get",
  "completion/complete",
  "logging/setLevel",
  "tasks/get",
  "tasks/list",
  "tasks/result",
  "tasks/update",
  "tasks/cancel",
  "notifications/cancelled",
  "notifications/progress",
  "notifications/roots/list_changed",
  "notifications/tasks/status",
]);

/** Every MCP protocol version is a date. */
const PROTOCOL_VERSION = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The fixed text of each 4xx the SDK's transport can send a POST
 * (`WebStandardStreamableHTTPServerTransport`, SDK 1.30.1). Two of them go
 * on after `: ` with a value, the protocol version the client sent or a
 * size, which the log leaves out.
 */
const SDK_REFUSALS: readonly string[] = [
  "Not Acceptable: Client must accept both application/json and text/event-stream",
  "Unsupported Media Type: Content-Type must be application/json",
  "Payload Too Large",
  "Parse error: Invalid JSON",
  "Invalid Request: Batch must not exceed 100 messages",
  "Parse error: Invalid JSON-RPC message",
  "Session not found",
  "Invalid Request: Only one initialization request is allowed",
  "Bad Request: Unsupported protocol version",
];

/** The entry of `SDK_REFUSALS` that the transport's error message is, or `other`. */
function sdkRefusal(message: string | undefined): string {
  return SDK_REFUSALS.find((fixed) => message === fixed || message?.startsWith(`${fixed}: `) === true) ?? "other";
}

/**
 * Logs a POST that the transport or `rpcErrors` refused with a 4xx (RED-360):
 * the status, the refusal's fixed text, the JSON-RPC method when it is in
 * `LOGGED_METHODS`, and `MCP-Protocol-Version` when it is a date. Nothing else
 * of the request. 401 and 403 are the token check's answers and are not logged.
 */
function logRefusal(req: Request, status: number, reason: string): void {
  if (status < 400 || status >= 500 || status === 401 || status === 403) return;
  const method = (req.body as { method?: unknown } | undefined)?.method;
  const version = req.get("mcp-protocol-version");
  logger.warn("MCP request refused", {
    status,
    reason,
    rpc_method: typeof method === "string" && LOGGED_METHODS.has(method) ? method : "other",
    protocol_version: version === undefined ? "absent" : PROTOCOL_VERSION.test(version) ? version : "other",
  });
}

/** The platform package's version. `../package.json` is `platform/package.json` from both `src/` and `dist/`. */
function platformVersion(): string {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof version !== "string") throw new Error("platform/package.json has no version");
  return version;
}

/** What the server tells a client about itself at `initialize`. */
const SERVER_INFO = { name: "ogmcp", version: platformVersion() };

/**
 * The MCP server of one request to `/mcp`, for the agent whose access token
 * `requireRead` accepted: `agent.userUuid` is the user. Stateless (D12): the
 * server lives for one request, so the tool list is computed per request
 * (§10.2), and its `tools` capability does not claim `listChanged`.
 *
 * It is the SDK's low-level `Server`, not `McpServer`: a kit's `ToolDef`
 * carries a JSON Schema (§6.2), and `McpServer` takes zod schemas only and
 * always claims `listChanged`.
 *
 * `tools/call` of an unknown tool name is a protocol error. A tool of a game
 * the user has not enabled gets an `isError` result instead (§10.5,
 * `tool-envelope.ts`). The SDK sends a thrown error's message to the client,
 * and a Postgres error's message can repeat a row, so any other error is
 * logged by its code alone and sent as "Internal error".
 *
 * `initialize` answers with the §10.5 behavior rules as `instructions`
 * (`instructions.ts`).
 */
function createMcpServer(agent: VerifiedToken, tools: ToolRegistry, log: (line: string) => void): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS });
  async function internal<T>(method: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      log(`MCP request failed: ${method} code=${failureCode(err)}`);
      throw new McpError(ErrorCode.InternalError, "Internal error");
    }
  }
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await internal("tools/list", () => tools.list(agent.userUuid)),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const result = await internal("tools/call", () => tools.call(agent, params.name, params.arguments));
    if (result === null) throw new McpError(ErrorCode.InvalidParams, "Unknown tool");
    return result;
  });
  return server;
}

export function mcpRouter(options: McpOptions): Router {
  const router = express.Router();
  const log = options.log ?? logger.error;
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

  // Stateless (D12): there is no stream for GET to open and no session for
  // DELETE to end. After the token check, so that an agent without a token
  // gets the challenge whatever its method.
  const onlyPost: RequestHandler = (req, res, next) => {
    if (req.method === "POST") return next();
    res.set("Allow", "POST");
    sendRpcError(res, 405, -32000, "Method not allowed");
  };

  // No compressed bodies: the limit then bounds what is parsed.
  const parseBody = express.json({ limit: MAX_MCP_BODY_BYTES, type: "application/json", inflate: false });

  // A new server and transport per request (D12). The transport answers with
  // one JSON body and no session ID. It refuses a POST that does not accept
  // both JSON and an event stream (406), or is not JSON (415), as the spec
  // requires. It reports each refusal to the server's `onerror` before it
  // answers, and has written the status when `handleRequest` returns.
  const serve: RequestHandler = async (req, res) => {
    const agent = currentToken(res);
    if (agent === null) throw new Error("no access token");
    const server = createMcpServer(agent, options.tools, log);
    let refusal: string | undefined;
    server.onerror = (err) => {
      refusal ??= err.message;
    };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_MCP_BODY_BYTES,
    });
    res.once("close", () => {
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    logRefusal(req, res.statusCode, sdkRefusal(refusal));
  };

  // A refusal of the route's own, logged as the transport's are.
  function refuse(req: Request, res: Response, status: number, code: number, message: string): void {
    logRefusal(req, status, message);
    sendRpcError(res, status, code, message);
  }

  // JSON-RPC errors, never the app's plain text. A body error's message
  // quotes the body, so only its type and status are read. Anything else is
  // logged by its code alone, as the app's handler does.
  const rpcErrors: ErrorRequestHandler = (err: unknown, req, res, next) => {
    if (res.headersSent) return next(err);
    const { type, status } = (err ?? {}) as { type?: unknown; status?: unknown };
    if (type === "entity.parse.failed") return refuse(req, res, 400, -32700, "Parse error");
    if (type === "entity.too.large") return refuse(req, res, 413, -32600, "Request too large");
    if (typeof status === "number" && status >= 400 && status < 500) return refuse(req, res, status, -32600, "Invalid request");
    log(`request failed: code=${failureCode(err)}`);
    sendRpcError(res, 500, -32603, "Internal error");
  };

  router.all(MCP_PATH, checkHost, checkOrigin, requireRead, onlyPost, parseBody, serve, rpcErrors);
  return router;
}
