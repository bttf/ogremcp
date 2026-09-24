import { PROVIDER_LABELS, useSession } from "../session.js";

/**
 * Where a signed-in user lands, and where sign-in returns to. It says who is
 * signed in until the §13.2 pages that belong here exist.
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
    </>
  );
}
