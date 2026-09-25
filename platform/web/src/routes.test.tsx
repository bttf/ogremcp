// @vitest-environment jsdom
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { AppRoutes } from "./routes.js";
import { SessionProvider } from "./session.js";

let root: Root | undefined;

/** Shows the router's path, for the test to read. */
function Path() {
  return <output data-testid="path">{useLocation().pathname}</output>;
}

afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("sends a signed-out user to the Sign in page, which links to each configured provider", async () => {
  // Signed out, and only Google is configured on this server.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    switch (String(input)) {
      case "/api/v1/me":
        return Response.json({ error: "signed_out" }, { status: 401 });
      case "/api/v1/sign-in-providers":
        return Response.json({ providers: ["google"] });
      default:
        return new Response("not found", { status: 404 });
    }
  });

  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  root.render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
        <Path />
      </MemoryRouter>
    </SessionProvider>,
  );

  await vi.waitFor(() => expect(container.querySelector("h1")?.textContent).toBe("Sign in"));
  expect(container.querySelector("[data-testid=path]")?.textContent).toBe("/signin");
  await vi.waitFor(() => expect(container.textContent).toContain("Sign-in with Discord is not configured on this server."));
  const links = [...container.querySelectorAll(".og-signin a")].map((a) => [a.textContent, a.getAttribute("href")]);
  expect(links).toEqual([["Continue with Google", "/auth/google"]]);
  // The page links to the Privacy and Terms pages (§13.2).
  const legal = [...container.querySelectorAll(".og-signin__legal a")].map((a) => a.getAttribute("href"));
  expect(legal).toEqual(["/privacy", "/terms"]);
  // The signed-in navigation and Sign out are not shown.
  expect(container.querySelector("nav")).toBeNull();
  expect(container.querySelector("form")).toBeNull();
});

it("passes the Sign in page's return_to on to each provider", async () => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
    String(input) === "/api/v1/sign-in-providers"
      ? Response.json({ providers: ["google", "discord"] })
      : Response.json({ error: "signed_out" }, { status: 401 }),
  );

  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  root.render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/signin?return_to=%2Finteraction%2Fabc"]}>
        <AppRoutes />
      </MemoryRouter>
    </SessionProvider>,
  );

  await vi.waitFor(() => expect(container.querySelectorAll(".og-signin a")).toHaveLength(2));
  expect([...container.querySelectorAll(".og-signin a")].map((a) => a.getAttribute("href"))).toEqual([
    "/auth/google?return_to=%2Finteraction%2Fabc",
    "/auth/discord?return_to=%2Finteraction%2Fabc",
  ]);
});
