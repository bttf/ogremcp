import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { format } from "node:util";

import type { Request, RequestHandler } from "express";

/**
 * The platform's log (§16): one JSON line per entry on stdout, which Railway
 * keeps and parses. No other vendor, and no logging library: this module is
 * the whole of it.
 *
 * A line holds `level`, `time`, and `msg`; then, inside a request,
 * `request_id`, `route`, and `user_uuid` when known; then the entry's own
 * fields. JSON escapes line breaks, so no value can forge a line. Deep code
 * (the database, ingest, `/mcp`, the OAuth server's hooks) gets the request's
 * fields from `AsyncLocalStorage`, without passing them along.
 *
 * No line holds a header, a cookie, a query string, a request body, an
 * authorization code, or a token. The access line has the method, the
 * matched route's pattern (never the path, which can hold IDs), the status,
 * and the duration. Callers log codes and counts, never a message that can
 * repeat a row (`failureCode`).
 *
 * Every line goes to stdout, errors too: Railway marks each stderr line an
 * error whatever its `level`.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/** An entry's own fields. `level`, `time`, `msg`, and the request's fields win over a field of the same name. */
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug: (msg: string, fields?: LogFields) => void;
  info: (msg: string, fields?: LogFields) => void;
  warn: (msg: string, fields?: LogFields) => void;
  error: (msg: string, fields?: LogFields) => void;
}

/** What every line written during one request carries. */
interface RequestContext {
  readonly requestId: string;
  /** The matched route's pattern, read when a line is written: the request finds its route as it moves through the app. */
  route: () => string | undefined;
  /** `users.uuid`, once the request's web session or access token names the user. */
  userUuid?: string;
  /**
   * Set after the access line. Work the request started can outlive it, such
   * as a pooled connection's error listener, and its lines must not name the
   * request or its user.
   */
  ended?: boolean;
}

const requests = new AsyncLocalStorage<RequestContext>();

let minimum = LOG_LEVELS.indexOf(DEFAULT_LOG_LEVEL);
let write = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

export interface LoggerSettings {
  /** `LOG_LEVEL`: the least severe level written. Default `info`. */
  level?: LogLevel;
  /** Receives each line. Default: stdout. */
  write?: (line: string) => void;
}

/** `index.ts` sets the level from `LOG_LEVEL`. Tests take the lines. */
export function configureLogger(settings: LoggerSettings): void {
  if (settings.level !== undefined) minimum = LOG_LEVELS.indexOf(settings.level);
  if (settings.write !== undefined) write = settings.write;
}

/** One line, as the logger writes it, in the current request's context while the request runs. */
export function formatLine(level: LogLevel, msg: string, fields: LogFields = {}, context = requests.getStore()): string {
  const line: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  line["level"] = level;
  line["time"] = new Date().toISOString();
  line["msg"] = msg;
  if (context !== undefined && context.ended !== true) {
    line["request_id"] = context.requestId;
    const route = context.route();
    if (route !== undefined) line["route"] = route;
    if (context.userUuid !== undefined) line["user_uuid"] = context.userUuid;
  }
  for (const [key, value] of Object.entries(fields)) {
    if (!Object.hasOwn(line, key)) line[key] = value;
  }
  return JSON.stringify(line);
}

/** Writes a line `formatLine` made at `level`, when `LOG_LEVEL` lets that level through. */
export function writeLine(level: LogLevel, line: string): void {
  if (LOG_LEVELS.indexOf(level) >= minimum) write(line);
}

function emit(level: LogLevel, msg: string, fields?: LogFields, context?: RequestContext): void {
  if (LOG_LEVELS.indexOf(level) < minimum) return;
  write(formatLine(level, msg, fields, context ?? requests.getStore()));
}

/** The platform's one logger. Its methods may be passed on alone, as a module's `log` option. */
export const logger: Logger = {
  debug: (msg, fields) => emit("debug", msg, fields),
  info: (msg, fields) => emit("info", msg, fields),
  warn: (msg, fields) => emit("warn", msg, fields),
  error: (msg, fields) => emit("error", msg, fields),
};

/**
 * Names the current request's route when no Express route matches it:
 * oidc-provider's routes, and the web UI's files and pages. It is a pattern or
 * a label, never a path with its IDs. A function is read when a line is
 * written.
 */
export function setRoute(route: string | (() => string | undefined)): void {
  const context = requests.getStore();
  if (context !== undefined) context.route = typeof route === "string" ? () => route : route;
}

/** Names the current request's user by `users.uuid`: the request's later lines carry it. */
export function setUserUuid(uuid: string): void {
  const context = requests.getStore();
  if (context !== undefined) context.userUuid = uuid;
}

/** Railway's edge names each request in this header, and its HTTP logs carry the same ID. */
export const EDGE_REQUEST_ID_HEADER = "x-railway-request-id";

/** Each response carries its request's ID in this header. */
export const REQUEST_ID_HEADER = "X-Request-Id";

const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Routes whose access lines are `debug`: Railway's healthcheck calls one every few seconds. */
const HEALTH_ROUTES: ReadonlySet<string> = new Set(["/health", "/health/live"]);

/** The pattern of the Express route that matched, such as `/api/v1/devices/:uuid`, with its router's mount path. */
function expressRoute(req: Request): string | undefined {
  const path = (req.route as { path?: unknown } | undefined)?.path;
  return typeof path === "string" ? `${req.baseUrl}${path}` : undefined;
}

export interface RequestLogOptions {
  /**
   * Whether the edge's `X-Railway-Request-Id` names the request. Only behind
   * a trusted proxy (`TRUST_PROXY_HOPS` above 0): otherwise a client could
   * pick the ID.
   */
  trustEdgeRequestId: boolean;
}

/**
 * The first middleware of the app. It gives the request an ID, the edge's
 * when trusted and well-formed and a new UUID otherwise, and sends it back in
 * `X-Request-Id`. It runs the rest of the request in that context, and writes
 * one access line when the response ends or the client goes away: `info`, or
 * `debug` for the health checks.
 */
export function requestLog({ trustEdgeRequestId }: RequestLogOptions): RequestHandler {
  return (req, res, next) => {
    const started = performance.now();
    const edge = trustEdgeRequestId ? req.get(EDGE_REQUEST_ID_HEADER) : undefined;
    const context: RequestContext = {
      requestId: edge !== undefined && REQUEST_ID.test(edge) ? edge : randomUUID(),
      route: () => expressRoute(req),
    };
    res.set(REQUEST_ID_HEADER, context.requestId);
    let logged = false;
    const done = (): void => {
      if (logged) return;
      logged = true;
      const route = context.route();
      const level = route !== undefined && HEALTH_ROUTES.has(route) ? "debug" : "info";
      emit(
        level,
        `${req.method} ${route ?? "(no route)"} ${res.statusCode}`,
        {
          method: req.method,
          status: res.statusCode,
          duration_ms: Math.round((performance.now() - started) * 10) / 10,
          ...(res.writableFinished ? {} : { aborted: true }),
        },
        context,
      );
      context.ended = true;
    };
    res.once("finish", done);
    res.once("close", done);
    requests.run(context, () => next());
  };
}

// The colour codes oidc-provider adds to its notices on a terminal.
const COLOUR = /\x1b\[[0-9;]*m/g;

// How Node starts a process warning, such as a deprecation, which it prints with `console.error`.
const NODE_WARNING = /^\(node:\d+\) /;

/**
 * Sends what the process prints with `console` through the logger:
 * `console.debug` at `debug`, `log` and `info` at `info`, `warn` at `warn`,
 * and `error` at `error`, but a Node process warning at `warn`.
 * oidc-provider prints its notices with `console.info` and its warnings with
 * `console.warn`, and has no hook for them. `index.ts` calls it at start.
 */
export function captureConsole(): void {
  const levels = { debug: "debug", log: "info", info: "info", warn: "warn", error: "error" } as const;
  for (const [name, level] of Object.entries(levels)) {
    console[name as keyof typeof levels] = (...args: unknown[]) => {
      const text = format(...args).replace(COLOUR, "");
      emit(NODE_WARNING.test(text) ? "warn" : level, text);
    };
  }
}
