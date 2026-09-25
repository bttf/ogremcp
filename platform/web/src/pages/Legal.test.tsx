// @vitest-environment jsdom
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { AppRoutes } from "../routes.js";
import { SessionProvider } from "../session.js";
import { PRIVACY_UPDATED } from "./Privacy.js";
import { TERMS_UPDATED } from "./Terms.js";

let root: Root | undefined;

afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** Shows the router's path, for the test to read. */
function Path() {
  return <output data-testid="path">{useLocation().pathname}</output>;
}

/** Renders `path` for a signed-out browser, with the contact email the service answers. */
async function render(path: string, email: string | null): Promise<HTMLElement> {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    switch (String(input)) {
      case "/api/v1/me":
        return Response.json({ error: "signed_out" }, { status: 401 });
      case "/api/v1/contact":
        return Response.json({ email });
      default:
        return new Response("not found", { status: 404 });
    }
  });
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  root.render(
    <SessionProvider>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
        <Path />
      </MemoryRouter>
    </SessionProvider>,
  );
  // The Contact section is filled once the service answers.
  await vi.waitFor(() => expect(container.querySelector(".og-legal > p:last-child")?.textContent).toMatch(/^(Email|Contact details)/));
  return container;
}

const PAGES = [
  { path: "/privacy", title: "Privacy policy", updated: PRIVACY_UPDATED },
  { path: "/terms", title: "Terms of use", updated: TERMS_UPDATED },
];

it("shows the Privacy and Terms pages to a signed-out browser, with the date and the contact email (§13.2)", async () => {
  for (const { path, title, updated } of PAGES) {
    const container = await render(path, "privacy@ogremcp.example");
    // Not sent to the Sign in page.
    expect(container.querySelector("[data-testid=path]")?.textContent).toBe(path);
    expect(container.querySelector("h1")?.textContent).toBe(title);
    expect(container.textContent).toContain(`Last updated ${updated}`);
    const contact = container.querySelector(".og-legal a[href^='mailto:']");
    expect([contact?.textContent, contact?.getAttribute("href")]).toEqual(["privacy@ogremcp.example", "mailto:privacy@ogremcp.example"]);
    // The footer links to both pages for everyone.
    expect([...container.querySelectorAll(".og-footer a")].map((a) => a.getAttribute("href"))).toEqual(["/privacy", "/terms"]);
    root?.unmount();
    root = undefined;
    document.body.replaceChildren();
  }
});

it("says contact details are coming soon when no contact email is configured", async () => {
  for (const { path } of PAGES) {
    const container = await render(path, null);
    expect(container.querySelector(".og-legal > p:last-child")?.textContent).toBe("Contact details coming soon.");
    expect(container.querySelector("a[href^='mailto:']")).toBeNull();
    root?.unmount();
    root = undefined;
    document.body.replaceChildren();
  }
});
