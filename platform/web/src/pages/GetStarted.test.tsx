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

const device = {
  uuid: "11111111-1111-4111-8111-111111111111",
  name: null,
  os: "windows",
  bridge_version: "0.1.0",
  approved_at: "2026-09-20T10:00:00.000Z",
  last_seen_at: null,
  revoked: false,
};

/** Renders Get started, with the download URL and the devices the service answers. */
async function render(downloadUrl: string | null, devices: unknown[]): Promise<HTMLElement> {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    switch (String(input)) {
      case "/api/v1/me":
        return Response.json({ uuid: "00000000-0000-4000-8000-000000000000", providers: ["google"] });
      case "/api/v1/setup":
        return Response.json({ mcp_url: "https://ogmcp.example/mcp", bridge_download_url: downloadUrl });
      case "/api/v1/devices":
        return Response.json({ devices });
      case "/api/v1/agents":
        return Response.json({ agents: [] });
      default:
        return new Response("not found", { status: 404 });
    }
  });
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  root.render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/get-started"]}>
        <AppRoutes />
      </MemoryRouter>
    </SessionProvider>,
  );
  await vi.waitFor(() => expect(container.querySelectorAll(".og-steps > li")).toHaveLength(3));
  return container;
}

/** Each step's heading, with its badge when it is done. */
function steps(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".og-steps > li .og-card__head")].map((head) => head.textContent ?? "");
}

it("shows the three steps, the download link when one is configured, and which steps are done", async () => {
  const container = await render("https://downloads.example/ogmcp-bridge", [device]);
  expect(container.querySelector("h1")?.textContent).toBe("Get started");
  // An approved bridge marks the first two steps done; no agent is connected yet.
  await vi.waitFor(() => expect(steps(container)).toEqual(["Download the bridgeDone", "Approve the bridgeDone", "Connect your agent"]));
  const links = [...container.querySelectorAll(".og-steps a")].map((a) => [a.textContent, a.getAttribute("href")]);
  expect(links).toEqual([
    ["Download the bridge", "https://downloads.example/ogmcp-bridge"],
    ["approval page", "/device"],
    ["Connect your agent", "/connect"],
  ]);
  root?.unmount();
  document.body.replaceChildren();

  // No download configured, and only a revoked bridge: no link, and nothing is done.
  const unconfigured = await render(null, [{ ...device, revoked: true }]);
  expect(unconfigured.textContent).toContain("The download is not available yet.");
  expect(unconfigured.querySelector(".og-steps a[href^='https:']")).toBeNull();
  expect(steps(unconfigured)).toEqual(["Download the bridge", "Approve the bridge", "Connect your agent"]);
});
