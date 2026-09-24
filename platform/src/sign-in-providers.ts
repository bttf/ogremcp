import {
  ArcticFetchError,
  decodeIdToken,
  Discord,
  Google,
  OAuth2RequestError,
  type OAuth2Tokens,
} from "arctic";

import type { Config } from "./config.js";
import type { ProviderName } from "./identities.js";

/**
 * Google and Discord sign-in through Arctic (§13.1). Each provider builds the
 * authorization URL and turns the code of its callback into the provider's
 * stable id for the account. Neither asks for an email or a profile: the
 * service links accounts by id only and never merges them by email.
 */
export interface SignInProvider {
  /** For messages, e.g. "Google". */
  label: string;
  /**
   * Whether the flow carries a PKCE code verifier. Google takes one. Arctic
   * documents that Discord supports PKCE only for public clients, and this
   * service is a confidential client, so Discord relies on `state` alone.
   */
  pkce: boolean;
  /** `codeVerifier` is null exactly when `pkce` is false. */
  authorizationUrl(state: string, codeVerifier: string | null): URL;
  /** Exchanges the code. Resolves to the provider's id for the account; rejects with a `SignInFailure`. */
  identify(code: string, codeVerifier: string | null): Promise<string>;
}

/** A provider for each name, or null where it is not configured. */
export type SignInProviders = Record<ProviderName, SignInProvider | null>;

/**
 * - `refused`: the provider turned the code down, or answered with an
 *   identity this service cannot use. Starting again may work.
 * - `unavailable`: the provider could not be reached or answered with an
 *   error of its own.
 */
export class SignInFailure extends Error {
  constructor(
    readonly kind: "refused" | "unavailable",
    /** An error class or a short reason, for the log. Never a token, a code, or a response body. */
    readonly reason: string,
  ) {
    super(`sign-in ${kind}: ${reason}`);
    this.name = "SignInFailure";
  }
}

/** Most time the Discord profile request may take. */
const PROFILE_TIMEOUT_MS = 10_000;

/** `oauth_identities.provider_user_id` is text; ids longer than this are refused. */
const MAX_PROVIDER_USER_ID = 255;

async function exchange(run: () => Promise<OAuth2Tokens>): Promise<OAuth2Tokens> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof OAuth2RequestError) throw new SignInFailure("refused", `OAuth2RequestError ${err.code}`);
    if (err instanceof ArcticFetchError) throw new SignInFailure("unavailable", "ArcticFetchError");
    throw new SignInFailure("unavailable", err instanceof Error ? err.constructor.name : "unknown");
  }
}

type GoogleClient = Pick<Google, "createAuthorizationURL" | "validateAuthorizationCode">;

const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

/**
 * Google, with the `openid` scope only. The account id is the ID token's
 * `sub`. The ID token comes straight from Google's token endpoint over TLS,
 * so its signature is not checked (OpenID Connect Core §3.1.3.7, step 6);
 * its issuer and audience are.
 */
export function googleProvider(client: GoogleClient, clientId: string): SignInProvider {
  return {
    label: "Google",
    pkce: true,
    authorizationUrl(state, codeVerifier) {
      if (codeVerifier === null) throw new Error("Google sign-in needs a PKCE code verifier");
      return client.createAuthorizationURL(state, codeVerifier, ["openid"]);
    },
    async identify(code, codeVerifier) {
      if (codeVerifier === null) throw new Error("Google sign-in needs a PKCE code verifier");
      const tokens = await exchange(() => client.validateAuthorizationCode(code, codeVerifier));
      let claims: Record<string, unknown>;
      try {
        claims = decodeIdToken(tokens.idToken()) as Record<string, unknown>;
      } catch {
        throw new SignInFailure("unavailable", "no readable ID token");
      }
      if (typeof claims["iss"] !== "string" || !GOOGLE_ISSUERS.has(claims["iss"])) throw new SignInFailure("refused", "ID token issuer");
      if (claims["aud"] !== clientId) throw new SignInFailure("refused", "ID token audience");
      const sub = claims["sub"];
      if (typeof sub !== "string" || sub === "" || sub.length > MAX_PROVIDER_USER_ID) throw new SignInFailure("refused", "ID token subject");
      return sub;
    },
  };
}

type DiscordClient = Pick<Discord, "createAuthorizationURL" | "validateAuthorizationCode">;

/**
 * Discord, with the `identify` scope only. The account id is the `id` of
 * `GET /users/@me`, a snowflake.
 */
export function discordProvider(client: DiscordClient, fetchProfile: typeof fetch = fetch): SignInProvider {
  return {
    label: "Discord",
    pkce: false,
    authorizationUrl(state) {
      return client.createAuthorizationURL(state, null, ["identify"]);
    },
    async identify(code) {
      const tokens = await exchange(() => client.validateAuthorizationCode(code, null));
      let body: unknown;
      try {
        const res = await fetchProfile("https://discord.com/api/v10/users/@me", {
          headers: { Authorization: `Bearer ${tokens.accessToken()}` },
          signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
        });
        if (!res.ok) throw new SignInFailure("unavailable", `profile status ${res.status}`);
        body = await res.json();
      } catch (err) {
        if (err instanceof SignInFailure) throw err;
        throw new SignInFailure("unavailable", err instanceof Error ? err.constructor.name : "unknown");
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
    google:
      google === null
        ? null
        : googleProvider(new Google(google.clientId, google.clientSecret, callbackUrl(publicBaseUrl, "google")), google.clientId),
    discord:
      discord === null
        ? null
        : discordProvider(new Discord(discord.clientId, discord.clientSecret, callbackUrl(publicBaseUrl, "discord"))),
  };
}
