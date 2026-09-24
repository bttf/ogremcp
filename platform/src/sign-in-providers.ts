import * as client from "openid-client";

import type { Config } from "./config.js";
import type { ProviderName } from "./identities.js";

/**
 * Google and Discord sign-in through `openid-client` (§13.1). Each provider
 * builds the authorization URL and turns its callback into the provider's
 * stable id for the account. Neither asks for an email or a profile: the
 * service links accounts by id only and never merges them by email.
 */
export interface SignInProvider {
  /** For messages, e.g. "Google". */
  label: string;
  /**
   * Starts a flow: where to send the browser, and the values the callback is
   * checked against. `codeVerifier` is null when the provider uses no PKCE.
   * Rejects with a `SignInFailure`.
   */
  begin(): Promise<{ url: URL; state: string; codeVerifier: string | null }>;
  /**
   * Finishes a flow from the callback's query. Resolves to the provider's id
   * for the account; rejects with a `SignInFailure`.
   */
  finish(query: URLSearchParams, expected: { state: string; codeVerifier: string | null }): Promise<string>;
}

/** A provider for each name, or null where it is not configured. */
export type SignInProviders = Record<ProviderName, SignInProvider | null>;

/**
 * - `refused`: the provider turned the sign-in down, or its answer failed a
 *   check (state, PKCE, ID token claims). Starting again may work.
 * - `unavailable`: the provider could not be reached or answered with
 *   something this service cannot read.
 */
export class SignInFailure extends Error {
  constructor(
    readonly kind: "refused" | "unavailable",
    /** An error class, code, or short reason, for the log. Never a token, a code, or a response body. */
    readonly reason: string,
  ) {
    super(`sign-in ${kind}: ${reason}`);
    this.name = "SignInFailure";
  }
}

export interface ProviderOptions {
  clientId: string;
  /** Never logged or repeated. */
  clientSecret: string;
  /** The registered redirect URI, `<PUBLIC_BASE_URL>/auth/<provider>/callback`. */
  redirectUri: string;
  /** Every request to the provider goes through it. Default: the global `fetch`. Tests pass a fake provider. */
  fetch?: typeof fetch;
}

/** Most time, in seconds, one request to a provider may take. */
const TIMEOUT_SECONDS = 10;

/** `oauth_identities.provider_user_id` is text; ids longer than this are refused. */
const MAX_PROVIDER_USER_ID = 255;

/** openid-client error codes that mean a check on the provider's answer failed. */
const CHECK_FAILED = new Set([
  "OAUTH_JWT_CLAIM_COMPARISON_FAILED",
  "OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED",
  "OAUTH_JWT_TIMESTAMP_CHECK_FAILED",
]);

function failure(err: unknown): SignInFailure {
  if (err instanceof SignInFailure) return err;
  if (err instanceof client.ResponseBodyError) return new SignInFailure("refused", `ResponseBodyError ${err.error}`);
  if (err instanceof client.AuthorizationResponseError) return new SignInFailure("refused", `AuthorizationResponseError ${err.error}`);
  if (err instanceof client.ClientError) {
    return new SignInFailure(CHECK_FAILED.has(err.code ?? "") ? "refused" : "unavailable", `ClientError ${err.code ?? "unknown"}`);
  }
  return new SignInFailure("unavailable", err instanceof Error ? err.constructor.name : "unknown");
}

function callbackUrlWith(redirectUri: string, query: URLSearchParams): URL {
  const url = new URL(redirectUri);
  url.search = query.toString();
  return url;
}

/** Runs `load` once, and again after it failed. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load().catch((err: unknown) => {
      pending = null;
      throw err;
    });
    return pending;
  };
}

/**
 * Google as an OpenID Connect provider, found by discovery at
 * `https://accounts.google.com` on first use. Authorization code flow with
 * PKCE and `state`, scope `openid` only. The account id is the ID token's
 * `sub`. openid-client checks the ID token's issuer, audience, and times; its
 * signature is not checked, as it comes straight from Google's token endpoint
 * over TLS (OpenID Connect Core §3.1.3.7, step 6).
 */
export function googleProvider({ clientId, clientSecret, redirectUri, fetch: fetchImpl = fetch }: ProviderOptions): SignInProvider {
  const configuration = once(() =>
    client.discovery(new URL("https://accounts.google.com"), clientId, clientSecret, undefined, {
      [client.customFetch]: (url, options) => fetchImpl(url, options),
      timeout: TIMEOUT_SECONDS,
    }),
  );
  return {
    label: "Google",
    async begin() {
      try {
        const config = await configuration();
        const state = client.randomState();
        const codeVerifier = client.randomPKCECodeVerifier();
        const url = client.buildAuthorizationUrl(config, {
          redirect_uri: redirectUri,
          scope: "openid",
          state,
          code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
          code_challenge_method: "S256",
        });
        return { url, state, codeVerifier };
      } catch (err) {
        throw failure(err);
      }
    },
    async finish(query, expected) {
      if (expected.codeVerifier === null) throw new SignInFailure("refused", "no PKCE code verifier");
      let sub: unknown;
      try {
        const tokens = await client.authorizationCodeGrant(await configuration(), callbackUrlWith(redirectUri, query), {
          expectedState: expected.state,
          pkceCodeVerifier: expected.codeVerifier,
          idTokenExpected: true,
        });
        sub = tokens.claims()?.sub;
      } catch (err) {
        throw failure(err);
      }
      if (typeof sub !== "string" || sub === "" || sub.length > MAX_PROVIDER_USER_ID) throw new SignInFailure("refused", "ID token subject");
      return sub;
    },
  };
}

/** Discord's OAuth 2 endpoints. Discord publishes no discovery document. */
const DISCORD: client.ServerMetadata = {
  issuer: "https://discord.com",
  authorization_endpoint: "https://discord.com/oauth2/authorize",
  token_endpoint: "https://discord.com/api/oauth2/token",
};

/**
 * Discord as a plain OAuth 2 provider, a confidential client with `state`,
 * scope `identify` only. The account id is the `id` of `GET /users/@me`, a
 * snowflake.
 */
export function discordProvider({ clientId, clientSecret, redirectUri, fetch: fetchImpl = fetch }: ProviderOptions): SignInProvider {
  const config = new client.Configuration(DISCORD, clientId, clientSecret);
  config[client.customFetch] = (url, options) => fetchImpl(url, options);
  config.timeout = TIMEOUT_SECONDS;
  return {
    label: "Discord",
    async begin() {
      const state = client.randomState();
      const url = client.buildAuthorizationUrl(config, { redirect_uri: redirectUri, scope: "identify", state });
      return { url, state, codeVerifier: null };
    },
    async finish(query, expected) {
      let body: unknown;
      try {
        const tokens = await client.authorizationCodeGrant(config, callbackUrlWith(redirectUri, query), { expectedState: expected.state });
        const res = await fetchImpl("https://discord.com/api/users/@me", {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT_SECONDS * 1000),
        });
        if (!res.ok) throw new SignInFailure("unavailable", `profile status ${res.status}`);
        body = await res.json();
      } catch (err) {
        throw failure(err);
      }
      const id = (body as { id?: unknown } | null)?.id;
      if (typeof id !== "string" || !/^\d{1,32}$/.test(id)) throw new SignInFailure("refused", "profile id");
      return id;
    },
  };
}

/** The redirect URI registered with each provider, e.g. `https://…/auth/google/callback`. */
export function callbackUrl(publicBaseUrl: string, provider: ProviderName): string {
  return `${publicBaseUrl}/auth/${provider}/callback`;
}

/** The providers whose credentials are set. The others are null, and their routes answer 503. */
export function createSignInProviders(config: Pick<Config, "publicBaseUrl" | "google" | "discord">): SignInProviders {
  const { google, discord, publicBaseUrl } = config;
  return {
    google: google === null ? null : googleProvider({ ...google, redirectUri: callbackUrl(publicBaseUrl, "google") }),
    discord: discord === null ? null : discordProvider({ ...discord, redirectUri: callbackUrl(publicBaseUrl, "discord") }),
  };
}
