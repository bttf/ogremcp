import { Link, NavLink, Outlet } from "react-router";

import { useSession } from "./session.js";

/**
 * The navigation of a signed-in user. Add a page here when it exists (§13.2).
 */
const NAV: readonly { to: string; label: string }[] = [
  { to: "/", label: "Home" },
  { to: "/get-started", label: "Get started" },
  { to: "/games", label: "Games" },
  { to: "/connect", label: "Connect your agent" },
  { to: "/devices", label: "Devices" },
  { to: "/agents", label: "Connected agents" },
  { to: "/account", label: "Account" },
];

/**
 * The frame every page sits in: the header, the centered column, and the
 * footer, which links to the Privacy and Terms pages for everyone (§13.2). A
 * signed-in user also gets the navigation and Sign out. Sign out is a form,
 * so it works as a plain POST: the service ends the web session and sends the
 * browser to `/`, which then sends it to the Sign in page.
 *
 * The app's name is the frame, not the page, so it is not a heading. The
 * top-level heading of each page is the page's own.
 *
 * Adapted from `web/src/Shell.tsx` in bttf/wow-guide@df80260.
 */
export function Shell() {
  const session = useSession();
  return (
    <div className="og-page">
      <div className="og-column">
        <header className="og-header">
          <div className="og-header__title">Open Gamer MCP</div>
          {session.status === "signed-in" && (
            <>
              <nav className="og-nav" aria-label="Main">
                <ul>
                  {NAV.map(({ to, label }) => (
                    <li key={to}>
                      <NavLink to={to} end>
                        {label}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </nav>
              <form className="og-signout" method="post" action="/auth/signout">
                <button type="submit">Sign out</button>
              </form>
            </>
          )}
        </header>
        <main>
          <Outlet />
        </main>
        <footer className="og-footer">
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
        </footer>
      </div>
    </div>
  );
}
