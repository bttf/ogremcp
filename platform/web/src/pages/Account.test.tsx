// @vitest-environment jsdom
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { AppRoutes } from "../routes.js";
import { SessionProvider } from "../session.js";

let root: Root | undefined;

afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function type(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setValue?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("deletes the user's data after a second click, and the account only once the phrase is typed", async () => {
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = `${init?.method ?? "GET"} ${String(input)}`;
    requests.push(request);
    switch (request) {
      case "GET /api/v1/me":
        return Response.json({ uuid: "00000000-0000-4000-8000-000000000000", providers: ["google"] });
      case "DELETE /api/v1/account/data":
        return new Response(null, { status: 204 });
      case "DELETE /api/v1/account":
        // Fails, so the page stays: jsdom cannot follow the page load that success starts.
        return new Response("Something went wrong. Try again.", { status: 500 });
      default:
        return new Response("not found", { status: 404 });
    }
  });

  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  root.render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/account"]}>
        <AppRoutes />
      </MemoryRouter>
    </SessionProvider>,
  );

  await vi.waitFor(() => expect(container.querySelectorAll(".og-card")).toHaveLength(2));
  expect(container.querySelector("h1")?.textContent).toBe("Account");
  const [data, account] = [...container.querySelectorAll<HTMLElement>(".og-card")];

  // Delete my data: the first click only asks.
  data?.querySelector("button")?.click();
  await vi.waitFor(() => expect(data?.textContent).toContain("Delete your data? This cannot be undone."));
  expect(requests).not.toContain("DELETE /api/v1/account/data");
  data?.querySelector("button")?.click();
  await vi.waitFor(() => expect(data?.querySelector("[role=status]")?.textContent).toBe("Your data is deleted."));
  expect(requests.filter((request) => request === "DELETE /api/v1/account/data")).toHaveLength(1);

  // Delete account: the button waits for the phrase.
  const input = account?.querySelector("input") ?? null;
  const button = account?.querySelector<HTMLButtonElement>("button[type=submit]") ?? null;
  if (input === null || button === null) throw new Error("no confirmation form");
  expect(button.disabled).toBe(true);
  type(input, "delete my");
  await vi.waitFor(() => expect(input.value).toBe("delete my"));
  expect(button.disabled).toBe(true);
  type(input, "delete my account");
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  button.click();
  await vi.waitFor(() => expect(account?.querySelector("[role=alert]")?.textContent).toBe("Your account was not deleted. Try again."));
  expect(requests).toContain("DELETE /api/v1/account");
});
