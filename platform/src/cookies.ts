import type { Request } from "express";

/**
 * The value of the cookie `name` in the request's `Cookie` header, or
 * undefined. Values this service sets are base64url or a few plain words, so
 * no decoding is needed; a value that is not plain printable ASCII counts as
 * absent. When the header names a cookie twice, the first wins, as browsers
 * send the most specific path first.
 */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (header === undefined) return undefined;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1 || pair.slice(0, eq).trim() !== name) continue;
    const value = pair.slice(eq + 1).trim();
    return /^[\x21-\x7e]{1,4096}$/.test(value) ? value : undefined;
  }
  return undefined;
}
