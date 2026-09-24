import type { Server } from "node:http";

export interface ServerLimits {
  /** Most time to receive the headers of a request. */
  headersTimeoutMs: number;
  /** Most time to receive a whole request, body included. */
  requestTimeoutMs: number;
  /** How long an idle keep-alive connection stays open. */
  keepAliveTimeoutMs: number;
  /** Open connections at once. A connection over it is closed at once. */
  maxConnections: number;
}

/**
 * What `applyServerLimits` sets.
 *
 * `requestTimeoutMs` covers receiving the request only. Node stops counting
 * once the request is in, so a slow answer is not cut off. The socket
 * inactivity timeout, `server.timeout`, stays at Node's default of none.
 *
 * `keepAliveTimeoutMs` is longer than the idle timeout of a common proxy, 60
 * seconds, so the proxy closes an idle connection first and never sends a
 * request on one this server has just closed.
 */
export const SERVER_LIMITS: ServerLimits = {
  headersTimeoutMs: 20_000,
  requestTimeoutMs: 60_000,
  keepAliveTimeoutMs: 65_000,
  maxConnections: 1_000,
};

export function applyServerLimits(server: Server, limits: ServerLimits = SERVER_LIMITS): Server {
  server.headersTimeout = limits.headersTimeoutMs;
  server.requestTimeout = limits.requestTimeoutMs;
  server.keepAliveTimeout = limits.keepAliveTimeoutMs;
  server.maxConnections = limits.maxConnections;
  return server;
}

/** Where the two outcomes are reported. The defaults are the process's own. */
export interface ListenIo {
  log?: (line: string) => void;
  error?: (line: string) => void;
  exit?: (code: number) => void;
}

/**
 * Listens on `port` and reports what happened.
 *
 * The start line names the address the socket bound, which is not the
 * configured port when that is 0. A bind that fails ends the process with a
 * message naming the port, since an unhandled `error` event would otherwise
 * end it with a stack trace.
 *
 * The listener is attached here rather than passed to `app.listen`: Express
 * hands that callback the error of a failed bind as well, so a process that
 * never bound would print a start line.
 */
export function startServer(server: Server, port: number, io: ListenIo = {}): Server {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  const exit = io.exit ?? process.exit;
  server.once("listening", () => {
    const address = server.address();
    log(`ogmcp platform listening on ${typeof address === "string" ? address : `:${address?.port}`}`);
  });
  server.once("error", (err: NodeJS.ErrnoException) => {
    error(
      err.code === "EADDRINUSE"
        ? `cannot listen on port ${port}: it is already in use. Set PORT to a free port.`
        : `cannot listen on port ${port}: ${err.message}`,
    );
    exit(1);
  });
  return server.listen(port);
}
