import { generateKeyPairSync, hash, randomBytes } from "node:crypto";

import type { JWK } from "oidc-provider";

/**
 * The OAuth server's secrets (§13.1): `OIDC_JWKS` and `OIDC_COOKIE_KEYS`.
 * No function here logs a key or repeats one in an error.
 */
export interface OidcKeys {
  /** `OIDC_JWKS`: the private signing keys, as a JWKS. The first key of each type signs. */
  jwks: { keys: JWK[] };
  /** `OIDC_COOKIE_KEYS`: the keys that sign oidc-provider's cookies. The first signs; every one verifies. */
  cookieKeys: string[];
}

/** Shortest cookie key accepted. `generateOidcKeys` makes 43 characters (32 random bytes). */
export const MIN_COOKIE_KEY_LENGTH = 32;

const KEY_TYPES = new Set(["RSA", "EC", "OKP"]);

/**
 * `OIDC_JWKS` and `OIDC_COOKIE_KEYS`, or null when both are unset. Throws when
 * only one is set or either is malformed. oidc-provider checks each key
 * further when it starts.
 */
export function parseOidcKeys(jwksValue: string | undefined, cookieKeysValue: string | undefined): OidcKeys | null {
  const rawJwks = (jwksValue ?? "").trim();
  const rawCookieKeys = (cookieKeysValue ?? "").trim();
  if (rawJwks === "" && rawCookieKeys === "") return null;
  if (rawJwks === "" || rawCookieKeys === "") throw new Error("OIDC_JWKS and OIDC_COOKIE_KEYS must be set together");

  // JSON.parse's message quotes the input, so it is never passed on.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJwks);
  } catch {
    throw new Error("OIDC_JWKS is not valid JSON");
  }
  const keys = (parsed as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length === 0) throw new Error('OIDC_JWKS must be a JSON object with a non-empty "keys" array');
  for (const [i, key] of keys.entries()) {
    const { kty, d } = (key ?? {}) as { kty?: unknown; d?: unknown };
    if (typeof kty !== "string" || !KEY_TYPES.has(kty)) throw new Error(`OIDC_JWKS key ${i} must be an RSA, EC, or OKP key`);
    if (typeof d !== "string" || d === "") throw new Error(`OIDC_JWKS key ${i} must be a private key`);
  }

  const cookieKeys = rawCookieKeys
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key !== "");
  if (cookieKeys.length === 0) throw new Error("OIDC_COOKIE_KEYS must hold at least one key");
  if (cookieKeys.some((key) => key.length < MIN_COOKIE_KEY_LENGTH)) {
    throw new Error(`each OIDC_COOKIE_KEYS key must be at least ${MIN_COOKIE_KEY_LENGTH} characters`);
  }

  return { jwks: { keys: keys as JWK[] }, cookieKeys };
}

/**
 * Fresh keys: one RSA 2048 signing key, which covers oidc-provider's default
 * RS256 ID tokens, and one cookie key. The `kid` is the key's RFC 7638
 * thumbprint.
 */
export function generateOidcKeys(): OidcKeys {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = privateKey.export({ format: "jwk" }) as JWK;
  const kid = hash("sha256", JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n }), "base64url");
  return {
    jwks: { keys: [{ ...jwk, kid, use: "sig" }] },
    cookieKeys: [randomBytes(32).toString("base64url")],
  };
}

/**
 * The two variables as `KEY=value` lines, for Railway or `platform/.env`.
 * Each value is one line with no `#` and does not start with a quote, so
 * Node's `--env-file` reads it whole.
 */
export function formatOidcKeys(keys: OidcKeys): string {
  return `OIDC_JWKS=${JSON.stringify(keys.jwks)}\nOIDC_COOKIE_KEYS=${keys.cookieKeys.join(",")}\n`;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The keys the OAuth server runs on: the configured ones, or else keys made
 * now, which last until the process ends (`ephemeral`). Keys made now are
 * allowed only on the local machine: `PUBLIC_BASE_URL` is plain http to a
 * loopback host and `NODE_ENV` is not `production` (Railpack sets it on
 * Railway). Anywhere else this throws, so the service does not start.
 */
export function resolveOidcKeys(
  configured: OidcKeys | null,
  publicBaseUrl: string,
  production: boolean,
): { keys: OidcKeys; ephemeral: boolean } {
  if (configured !== null) return { keys: configured, ephemeral: false };
  const url = new URL(publicBaseUrl);
  if (production || url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      "OIDC_JWKS and OIDC_COOKIE_KEYS must be set. Only a local run (PUBLIC_BASE_URL on http://localhost, NODE_ENV not production) may start without them",
    );
  }
  return { keys: generateOidcKeys(), ephemeral: true };
}
