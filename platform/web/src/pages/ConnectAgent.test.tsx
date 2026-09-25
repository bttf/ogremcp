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
  Reflect.deleteProperty(navigator, "clipboard");
});

it("shows the MCP URL with a copy button, and steps for each target client", async () => {
  const url = "https://ogmcp.example/mcp";
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    switch (String(input)) {
      case "/api/v1/me":
        return Response.json({ uuid: "00000000-0000-4000-8000-000000000000", providers: ["google"] });
      case "/api/v1/setup":
        return Response.json({ mcp_url: url, bridge_download_url: null });
      default:
        return new Response("not found", { status: 404 });
    }
  });
  const copied: string[] = [];
  // jsdom has no clipboard.
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) => {
        copied.push(text);
        return Promise.resolve();
      },
    },
  });

  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  root.render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/connect"]}>
        <AppRoutes />
      </MemoryRouter>
    </SessionProvider>,
  );

  await vi.waitFor(() => expect(container.querySelector(".og-copy code")?.textContent).toBe(url));
  expect(container.querySelector("h1")?.textContent).toBe("Connect your agent");
  expect([...container.querySelectorAll("h2")].map((h2) => h2.textContent)).toEqual(["Claude", "Claude Code", "ChatGPT", "Perplexity"]);
  expect(container.textContent).toContain("Claude's Free plan allows one custom connector.");
  expect([...container.querySelectorAll(".og-copy code")].map((code) => code.textContent)).toEqual([
    url,
    `claude mcp add --transport http --scope user ogmcp ${url}`,
  ]);

  container.querySelector<HTMLButtonElement>(".og-copy button")?.click();
  await vi.waitFor(() => expect(container.querySelector(".og-copy [role=status]")?.textContent).toBe("Copied."));
  expect(copied).toEqual([url]);
});
