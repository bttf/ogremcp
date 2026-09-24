import { type RouteObject, useRoutes } from "react-router";

import { Games } from "./pages/Games.js";
import { Home } from "./pages/Home.js";
import { NotFound } from "./pages/NotFound.js";
import { SignIn } from "./pages/SignIn.js";
import { RequireSession } from "./RequireSession.js";
import { Shell } from "./Shell.js";

/**
 * The route table. Adapted from `web/src/routes.tsx` in
 * bttf/wow-guide@df80260.
 */
export const routes: RouteObject[] = [
  {
    element: <Shell />,
    children: [
      { path: "/signin", element: <SignIn /> },
      {
        element: <RequireSession />,
        children: [
          { path: "/", element: <Home /> },
          { path: "/games", element: <Games /> },
        ],
      },
      { path: "*", element: <NotFound /> },
    ],
  },
];

/**
 * The app under a router. `main.tsx` puts it under a `BrowserRouter` and the
 * tests under a `MemoryRouter`, so both run the same routes. No route loads
 * data through the router, so it needs none of the data router's APIs. It
 * needs a `SessionProvider` above it.
 */
export function AppRoutes() {
  return useRoutes(routes);
}
