// @vitest-environment jsdom
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { AppRoutes } from "../routes.js";
import { SessionProvider } from "../session.js";
import { APPROVE_DELAY_MS } from "./Consent.js";

let root: Root | undefined;

afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("enables Approve once the page has been focused for a while, and waits again when focus comes back", async () => {
  // jsdom has no window focus of its own.
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    switch (String(input)) {
      case "/api/v1/me":
        return Response.json({ uuid: "00000000-0000-4000-8000-000000000000", providers: ["google"] });
      case "/interaction/abc/details":
        return Response.json({ prompt: { name: "consent" }, client_name: "Claude", client_host: "claude.ai", redirect_host: "claude.ai", scopes: ["read"] });
      default:
        return new Response("not found", { status: 404 });
    }
  });

  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  root.render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/consent/abc"]}>
        <AppRoutes />
      </MemoryRouter>
    </SessionProvider>,
  );

  const [approve, deny] = await vi.waitFor(() => {
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".og-consent__actions button")];
    if (buttons.length !== 2) throw new Error("no buttons yet");
    return buttons;
  });
  expect(container.querySelector("bdi")?.textContent).toBe("Claude");
  expect(container.textContent).toContain("Read your game state and search game info");
  expect(container.textContent).toContain("Its name comes from claude.ai.");
  expect(approve?.disabled).toBe(true);
  expect(deny?.disabled).toBe(false);
  await vi.waitFor(() => expect(approve?.disabled).toBe(false), { timeout: APPROVE_DELAY_MS * 2 });

  window.dispatchEvent(new Event("blur"));
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() => expect(approve?.disabled).toBe(true));
  expect(deny?.disabled).toBe(false);
  await vi.waitFor(() => expect(approve?.disabled).toBe(false), { timeout: APPROVE_DELAY_MS * 2 });
});
