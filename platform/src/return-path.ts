/** Longest return path accepted. An interaction path is under 40 characters. */
const MAX_LENGTH = 512;

/**
 * `value` as a path on this service to send the browser to after sign-in,
 * or null when it is anything else. The sign-in routes take it as
 * `return_to`, so it comes from the query and is never trusted: only a path
 * that stays on `publicBaseUrl`'s origin passes, and the result is its path
 * and query alone. That rules out another origin, a scheme, and a
 * protocol-relative `//host`, including one that only appears after the path
 * is resolved, such as `/.//host`.
 */
export function safeReturnPath(value: unknown, publicBaseUrl: string): string | null {
  if (typeof value !== "string" || value.length > MAX_LENGTH) return null;
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\x00-\x20\x7f]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, publicBaseUrl);
  } catch {
    return null;
  }
  if (url.origin !== new URL(publicBaseUrl).origin || url.pathname.startsWith("//")) return null;
  return `${url.pathname}${url.search}`;
}
