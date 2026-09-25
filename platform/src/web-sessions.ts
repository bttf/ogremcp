import { createHash, randomBytes } from "node:crypto";

import type { RequestHandler, Response } from "express";
import type { Pool } from "pg";

import { readCookie } from "./cookies.js";
import { setUserUuid } from "./log.js";

/**
 * Web sessions (§3, §13.1): signed-in browsers on the web UI, kept in
 * `web_sessions` after the Lucia sessions guide (lucia-auth.com).
 *
 * The cookie holds a random token of 32 bytes, base64url. The table holds only
 * the token's SHA-256, so a copy of the table opens no web session. Nothing is
 * signed: the token is checked against the table on each request, so there is
 * no cookie key.
 *
 * A web session ends `lifetimeMs` after it was created or last renewed. A
 * request that comes with less than `renewWithinMs` left renews it: the row
 * and the cookie get a new expiry. An expired row is deleted when it is next
 * presented.
 */

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** 32 random bytes, base64url without padding: 43 characters. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What `web_sessions.token_hash` holds for a token: the SHA-256 of its characters. */
export function hashSessionToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** The signed-in user of a request. */
export interface CurrentUser {
  /** `users.id`. Internal: no response, page, or log line shows it (§11). */
  id: string;
  /** `users.uuid`. */
  uuid: string;
  /** `web_sessions.uuid` of the web session the request came with. */
  sessionUuid: string;
}

export interface WebSessionOptions {
  pool: Pool;
  lifetimeMs: number;
  renewWithinMs: number;
  /** Whether the cookie is `Secure`: true when the service is reached over https. */
  secure: boolean;
  /** Default: the system clock. */
  now?: () => Date;
}

/** Where the middleware leaves the current user, in `res.locals`. */
const USER = "ogmcpUser";

export class WebSessions {
  /**
   * `__Host-` over https, so that only this host, over https, with `Path=/`,
   * can set it. Browsers refuse that prefix without `Secure`, so plain http on
   * the local machine uses the bare name.
   */
  readonly cookieName: string;
  /** Whether cookies are `Secure`. The sign-in cookies follow it too. */
  readonly secure: boolean;
  private readonly pool: Pool;
  private readonly lifetimeMs: number;
  private readonly renewWithinMs: number;
  private readonly now: () => Date;

  constructor(options: WebSessionOptions) {
    this.pool = options.pool;
    this.lifetimeMs = options.lifetimeMs;
    this.renewWithinMs = options.renewWithinMs;
    this.secure = options.secure;
    this.now = options.now ?? (() => new Date());
    this.cookieName = options.secure ? "__Host-ogmcp_session" : "ogmcp_session";
  }

  /** Starts a web session for the user of `users.id` `userId`. The token goes in the cookie and nowhere else. */
  async create(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = generateSessionToken();
    const expiresAt = new Date(this.now().getTime() + this.lifetimeMs);
    await this.pool.query("insert into web_sessions (user_id, token_hash, expires_at) values ($1, $2, $3)", [
      userId,
      hashSessionToken(token),
      expiresAt,
    ]);
    return { token, expiresAt };
  }

  /**
   * The user of a token, or null when the token is malformed, unknown, or
   * expired. An expired row is deleted. A web session with less than
   * `renewWithinMs` left is renewed, and `renewed` says so: the caller sets
   * the cookie again with the new expiry.
   */
  async validate(token: string): Promise<{ user: CurrentUser; expiresAt: Date; renewed: boolean } | null> {
    if (!TOKEN.test(token)) return null;
    const { rows } = await this.pool.query<{
      session_id: string;
      session_uuid: string;
      expires_at: Date;
      user_id: string;
      user_uuid: string;
    }>(
      `select s.id as session_id, s.uuid as session_uuid, s.expires_at, u.id as user_id, u.uuid as user_uuid
         from web_sessions s
         join users u on u.id = s.user_id
        where s.token_hash = $1`,
      [hashSessionToken(token)],
    );
    const row = rows[0];
    if (row === undefined) return null;
    const now = this.now().getTime();
    if (row.expires_at.getTime() <= now) {
      await this.pool.query("delete from web_sessions where id = $1", [row.session_id]);
      return null;
    }
    let expiresAt = row.expires_at;
    let renewed = false;
    if (expiresAt.getTime() - now < this.renewWithinMs) {
      expiresAt = new Date(now + this.lifetimeMs);
      await this.pool.query("update web_sessions set expires_at = $2 where id = $1", [row.session_id, expiresAt]);
      renewed = true;
    }
    return { user: { id: row.user_id, uuid: row.user_uuid, sessionUuid: row.session_uuid }, expiresAt, renewed };
  }

  /** Ends the web session of `web_sessions.uuid` `sessionUuid`. */
  async invalidate(sessionUuid: string): Promise<void> {
    await this.pool.query("delete from web_sessions where uuid = $1", [sessionUuid]);
  }

  /** httpOnly, SameSite=Lax, `Secure` over https, and expiring with the row. */
  setCookie(res: Response, token: string, expiresAt: Date): void {
    res.cookie(this.cookieName, token, { httpOnly: true, secure: this.secure, sameSite: "lax", path: "/", expires: expiresAt });
  }

  clearCookie(res: Response): void {
    res.clearCookie(this.cookieName, { httpOnly: true, secure: this.secure, sameSite: "lax", path: "/" });
  }

  /**
   * Resolves the current user from the cookie for every later handler, which
   * reads it with `currentUser(res)`, and for the request's log lines. A
   * request without the cookie costs no query. A cookie that no longer opens a
   * web session is cleared.
   */
  middleware(): RequestHandler {
    return async (req, res, next) => {
      let user: CurrentUser | null = null;
      const token = readCookie(req, this.cookieName);
      if (token !== undefined) {
        const found = await this.validate(token);
        if (found === null) {
          this.clearCookie(res);
        } else {
          user = found.user;
          setUserUuid(user.uuid);
          if (found.renewed) this.setCookie(res, token, found.expiresAt);
        }
      }
      res.locals[USER] = user;
      next();
    };
  }
}

/**
 * The signed-in user of the request, or null. Throws when `WebSessions.middleware`
 * has not run for the request, so a route mounted before it fails loudly
 * instead of treating everyone as signed out.
 */
export function currentUser(res: Response): CurrentUser | null {
  const user = res.locals[USER] as CurrentUser | null | undefined;
  if (user === undefined) throw new Error("the web session middleware has not run for this request");
  return user;
}
