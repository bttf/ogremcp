import { Navigate, Outlet } from "react-router";

import { useSession } from "./session.js";

/**
 * A layout route for pages that need a signed-in user. It waits while the
 * session loads, sends a signed-out user to the Sign in page, and renders the
 * child route otherwise.
 *
 * Adapted from `web/src/RequireSession.tsx` in bttf/wow-guide@df80260.
 */
export function RequireSession() {
  const session = useSession();
  switch (session.status) {
    case "loading":
      return <p>Loading…</p>;
    case "error":
      return (
        <>
          <h1>Something went wrong</h1>
          <p role="alert">Ogre MCP did not answer. Reload the page to try again.</p>
        </>
      );
    case "signed-out":
      return <Navigate to="/signin" replace />;
    case "signed-in":
      return <Outlet />;
  }
}
