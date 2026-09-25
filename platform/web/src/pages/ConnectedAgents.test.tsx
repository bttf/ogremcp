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

it("lists connected agents and revokes one after confirming", async () => {
  const claude = {
    id: "11111111-1111-4111-8111-111111111111",
    client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata",
    client_name: "Claude",
    client_host: "claude.ai",
    approved_at: "2026-09-20T10:00:00.000Z",
    last_used_at: "2026-09-24T18:02:11.000Z",
  };
  const unnamed = {
    ...claude,
    id: "22222222-2222-4222-8222-222222222222",
    client_id: "dcr-client",
    client_name: null,
    client_host: null,
    last_used_at: null,
  };
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = `${init?.method ?? "GET"} ${String(input)}`;
    requests.push(request);
    switch (request) {
      case "GET /api/v1/me":
        return Response.json({ uuid: "00000000-0000-4000-8000-000000000000", providers: ["google"] });
      case "GET /api/v1/agents":
        return Response.json({ agents: [claude, unnamed] });
      case `DELETE /api/v1/agents/${claude.id}`:
        return new Response(null, { status: 204 });
      default:
        return new Response("not found", { status: 404 });
    }
  });

  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  root.render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/agents"]}>
        <AppRoutes />
      </MemoryRouter>
    </SessionProvider>,
  );

  await vi.waitFor(() => expect(container.querySelectorAll(".og-card")).toHaveLength(2));
  expect(container.querySelector("h1")?.textContent).toBe("Connected agents");
  expect([...container.querySelectorAll("h2")].map((h2) => h2.textContent)).toEqual(["Claude", "An agent with no name"]);
  const first = container.querySelector(".og-card");
  expect(first?.textContent).toContain("Its name comes from claude.ai.");
  expect(first?.textContent).toContain("Last used");
  expect(container.querySelectorAll(".og-card")[1]?.textContent).not.toContain("Last used");

  first?.querySelector("button")?.click();
  await vi.waitFor(() => expect(first?.textContent).toContain("Revoke this agent?"));
  first?.querySelector("button")?.click();
  await vi.waitFor(() => expect([...container.querySelectorAll("h2")].map((h2) => h2.textContent)).toEqual(["An agent with no name"]));
  expect(requests).toContain(`DELETE /api/v1/agents/${claude.id}`);
});
