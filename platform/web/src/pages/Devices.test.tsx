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

function buttons(card: Element): string[] {
  return [...card.querySelectorAll("button")].map((button) => button.textContent ?? "");
}

it("lists devices with a fallback name, renames one, and revokes one", async () => {
  const unnamed = {
    uuid: "11111111-1111-4111-8111-111111111111",
    name: null,
    os: null,
    bridge_version: null,
    approved_at: "2026-09-20T10:00:00.000Z",
    last_seen_at: null,
    revoked: false,
  };
  const named = {
    ...unnamed,
    uuid: "22222222-2222-4222-8222-222222222222",
    name: "Gaming PC",
    os: "windows",
    bridge_version: "0.1.0",
    last_seen_at: "2026-09-24T18:02:11.000Z",
  };
  const revoked = { ...unnamed, uuid: "33333333-3333-4333-8333-333333333333", os: "darwin", revoked: true };
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = `${init?.method ?? "GET"} ${String(input)}`;
    requests.push(init?.body === undefined ? request : `${request} ${String(init.body)}`);
    switch (request) {
      case "GET /api/v1/me":
        return Response.json({ uuid: "00000000-0000-4000-8000-000000000000", providers: ["google"] });
      case "GET /api/v1/devices":
        return Response.json({ devices: [unnamed, named, revoked] });
      case `PATCH /api/v1/devices/${unnamed.uuid}`:
        return Response.json({ ...unnamed, name: "Laptop" });
      case `DELETE /api/v1/devices/${named.uuid}`:
        return Response.json({ ...named, revoked: true });
      default:
        return new Response("not found", { status: 404 });
    }
  });

  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  root.render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/devices"]}>
        <AppRoutes />
      </MemoryRouter>
    </SessionProvider>,
  );

  const cards = await vi.waitFor(() => {
    const found = container.querySelectorAll(".og-card");
    if (found.length !== 3) throw new Error("no devices yet");
    return [...found];
  });
  const [first, second, third] = cards as [Element, Element, Element];
  expect(container.querySelector("h1")?.textContent).toBe("Devices");
  expect(first.querySelector("h2")?.textContent).toMatch(/^Bridge approved /);
  expect(first.textContent).toContain("Last seenNot yet");
  expect(second.querySelector("h2")?.textContent).toBe("Gaming PC");
  expect(second.textContent).toContain("SystemWindows");
  expect(second.textContent).toContain("Bridge version0.1.0");
  expect(third.querySelector("h2")?.textContent).toMatch(/^macOS bridge approved /);
  expect(third.querySelector(".og-badge")?.textContent).toBe("Revoked");
  expect(buttons(third)).toEqual([]);

  // Rename the unnamed device.
  first.querySelector<HTMLButtonElement>("button")?.click();
  const input = await vi.waitFor(() => {
    const found = first.querySelector("input");
    if (found === null) throw new Error("no name field yet");
    return found;
  });
  expect(input.maxLength).toBe(64);
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setValue?.call(input, "Laptop");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  first.querySelector<HTMLButtonElement>("button[type=submit]")?.click();
  await vi.waitFor(() => expect(first.querySelector("h2")?.textContent).toBe("Laptop"));
  expect(requests).toContain(`PATCH /api/v1/devices/${unnamed.uuid} {"name":"Laptop"}`);

  // Revoke the named one, after confirming.
  expect(buttons(second)).toEqual(["Rename", "Revoke"]);
  second.querySelectorAll<HTMLButtonElement>("button")[1]?.click();
  await vi.waitFor(() => expect(second.textContent).toContain("Revoke this bridge?"));
  second.querySelector<HTMLButtonElement>("button")?.click();
  await vi.waitFor(() => expect(second.querySelector(".og-badge")?.textContent).toBe("Revoked"));
  expect(requests).toContain(`DELETE /api/v1/devices/${named.uuid}`);
  expect(buttons(second)).toEqual([]);
});
