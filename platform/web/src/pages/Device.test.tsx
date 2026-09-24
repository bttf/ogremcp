// @vitest-environment jsdom
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { AppRoutes } from "../routes.js";
import { SessionProvider } from "../session.js";

let root: Root | undefined;

/** Shows the router's path and query, for the test to read. */
function Location() {
  const { pathname, search } = useLocation();
  return <output data-testid="location">{`${pathname}${search}`}</output>;
}

afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function render(path: string): HTMLElement {
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  root.render(
    <SessionProvider>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
        <Location />
      </MemoryRouter>
    </SessionProvider>,
  );
  return container;
}

it("looks up the code of the bridge's link, names what asks, and posts the answer to the service", async () => {
  const posted: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    switch (String(input)) {
      case "/api/v1/me":
        return Response.json({ uuid: "00000000-0000-4000-8000-000000000000", providers: ["google"] });
      case "/device":
        if (init?.method !== "POST") return Response.json({ step: "enter", xsrf: "x1" });
        posted.push(String(init.body));
        return Response.json({ step: "confirm", xsrf: "x1", user_code: "BCDF-GHJK", client_name: "Open Gamer MCP bridge" });
      default:
        return new Response("not found", { status: 404 });
    }
  });

  const container = render("/device?user_code=bcdf-ghjk");
  const form = await vi.waitFor(() => {
    const found = container.querySelector<HTMLFormElement>("form.og-device__actions");
    if (found === null) throw new Error("no form yet");
    return found;
  });
  // The code goes to the service in its stored form.
  expect(posted).toEqual(["xsrf=x1&user_code=BCDFGHJK"]);
  expect(container.querySelector("bdi")?.textContent).toBe("Open Gamer MCP bridge");
  expect(container.querySelector(".og-device__code")?.textContent).toBe("BCDF-GHJK");
  expect(container.textContent).toContain("Approve only a code you started on your own computer.");
  expect([form.method, form.getAttribute("action")]).toEqual(["post", "/device"]);
  const fields = [...form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")].map((field) => [field.name, field.value]);
  expect(fields).toEqual([
    ["xsrf", "x1"],
    ["user_code", "BCDF-GHJK"],
    ["confirm", "yes"],
    ["abort", "yes"],
  ]);
});

it("sends a signed-out user to sign in, with the code in the way back", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ error: "signed_out" }, { status: 401 }));
  const container = render("/device?user_code=BCDF-GHJK");
  await vi.waitFor(() => expect(container.querySelector("h1")?.textContent).toBe("Sign in"));
  expect(container.querySelector("[data-testid=location]")?.textContent).toBe(`/signin?return_to=${encodeURIComponent("/device?user_code=BCDF-GHJK")}`);
});
