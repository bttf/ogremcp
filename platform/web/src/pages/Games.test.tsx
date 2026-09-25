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

it("lists WoW with a switch that enables it, then shows its in-game tips", async () => {
  const wow = { kit: "wow", name: "World of Warcraft" };
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = `${init?.method ?? "GET"} ${String(input)}`;
    requests.push(request);
    switch (request) {
      case "GET /api/v1/me":
        return Response.json({ uuid: "00000000-0000-4000-8000-000000000000", providers: ["google"] });
      case "GET /api/v1/games":
        return Response.json({ games: [{ ...wow, enabled: false }] });
      case "PUT /api/v1/games/wow":
        return Response.json({ ...wow, enabled: true });
      default:
        return new Response("not found", { status: 404 });
    }
  });

  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  root.render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/games"]}>
        <AppRoutes />
      </MemoryRouter>
    </SessionProvider>,
  );

  const toggle = await vi.waitFor(() => {
    const input = container.querySelector<HTMLInputElement>("input[role=switch]");
    if (input === null) throw new Error("no switch yet");
    return input;
  });
  expect(container.querySelector("h1")?.textContent).toBe("Games");
  expect(container.querySelector("h2")?.textContent).toBe("World of Warcraft");
  expect(container.textContent).toContain("The bridge picks up changes on its own.");
  expect([...container.querySelectorAll("nav a")].map((a) => a.textContent)).toEqual([
    "Home",
    "Get started",
    "Games",
    "Connect your agent",
    "Devices",
    "Connected agents",
  ]);
  expect(toggle.checked).toBe(false);
  expect(container.querySelector(".og-tips")).toBeNull();

  toggle.click();
  await vi.waitFor(() => expect(toggle.checked).toBe(true));
  expect(requests).toContain("PUT /api/v1/games/wow");
  expect([...container.querySelectorAll(".og-tips li")].map((li) => li.textContent)).toEqual([
    "Type /transmit in game to send your latest state.",
    "Restart WoW after the addon's first install.",
    "Close WoW to finish an addon update.",
  ]);
});
