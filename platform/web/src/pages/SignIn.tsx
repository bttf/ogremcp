import { useEffect, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router";

import { PROVIDER_LABELS, PROVIDERS, type Provider, useSession } from "../session.js";

/**
 * The providers the service has credentials for, from
 * `GET /api/v1/sign-in-providers`, or null until it answers. When the request
 * fails, every provider stays offered: its `/auth/<provider>` route answers
 * 503 with a plain message of its own.
 */
function useConfiguredProviders(): readonly Provider[] | null {
  const [configured, setConfigured] = useState<readonly Provider[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/sign-in-providers", { headers: { Accept: "application/json" } })
      .then(async (res) => (res.ok ? ((await res.json()) as { providers: Provider[] }).providers : PROVIDERS))
      .catch(() => PROVIDERS)
      .then((providers) => {
        if (!cancelled) setConfigured(providers);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return configured;
}

/**
 * The Sign in page (§13.2): Google and Discord. Each is a link to the
 * service's `/auth/<provider>`, which sends the browser on to the provider;
 * after sign-in the service sends it back to `/`. A `return_to` in the page's
 * query goes on to `/auth/<provider>`, which sends the browser there instead
 * when it is a path on this service: an OAuth interaction sends a signed-out
 * browser here that way (§9), and so does one that must sign in again. A
 * provider without credentials on this server gets a plain sentence instead
 * of a link. The page links to the Privacy and Terms pages (§13.2).
 *
 * Adapted from `web/src/pages/Login.tsx` in bttf/wow-guide@df80260.
 */
export function SignIn() {
  const session = useSession();
  const configured = useConfiguredProviders();
  const returnTo = useSearchParams()[0].get("return_to");
  const query = returnTo === null ? "" : `?return_to=${encodeURIComponent(returnTo)}`;

  // With a return_to, a signed-in user may be asked to sign in again, as an
  // agent's `prompt=login` does.
  if (session.status === "signed-in" && returnTo === null) return <Navigate to="/" replace />;

  return (
    <>
      <h1>Sign in</h1>
      <p>
        {session.status === "signed-in"
          ? "Sign in again with your Google or Discord account to continue."
          : "Sign in with your Google or Discord account."}
      </p>
      <ul className="og-signin">
        {PROVIDERS.map((provider) => (
          <li key={provider}>
            {configured === null || configured.includes(provider) ? (
              <a className="og-button" href={`/auth/${provider}${query}`}>
                Continue with {PROVIDER_LABELS[provider]}
              </a>
            ) : (
              <p>Sign-in with {PROVIDER_LABELS[provider]} is not configured on this server.</p>
            )}
          </li>
        ))}
      </ul>
      <p className="og-signin__legal">
        Read the <Link to="/privacy">Privacy policy</Link> and the <Link to="/terms">Terms of use</Link>.
      </p>
    </>
  );
}
