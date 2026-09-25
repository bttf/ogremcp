import { Link } from "react-router";

import { PROVIDER_LABELS, useSession } from "../session.js";

/**
 * Where a signed-in user lands, and where sign-in returns to. It says who is
 * signed in and links to the Get started page (§13.2).
 */
export function Home() {
  const session = useSession();
  const providers = session.status === "signed-in" ? session.me.providers : [];
  return (
    <>
      <h1>Home</h1>
      <p>
        You are signed in.
        {providers.length > 0 && ` Linked accounts: ${providers.map((provider) => PROVIDER_LABELS[provider]).join(", ")}.`}
      </p>
      <p>New here? Download the bridge, approve it, and connect your AI agent.</p>
      <p>
        <Link className="og-button og-button--inline" to="/get-started">
          Get started
        </Link>
      </p>
    </>
  );
}
