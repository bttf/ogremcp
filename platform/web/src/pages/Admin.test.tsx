// @vitest-environment jsdom
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { AppRoutes } from "../routes.js";
import { SessionProvider } from "../session.js";
import type { AdminMetrics } from "./Admin.js";

let root: Root | undefined;

afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const ME = { uuid: "00000000-0000-4000-8000-000000000000", providers: ["google"] };

const METRICS: AdminMetrics = {
  window: { days: 7, since: "2026-09-18T00:00:00.000Z", until: "2026-09-25T00:00:00.000Z" },
  bridges: [{ bridge_version: "0.1.0", os: "windows", devices: 3, requests: 120, errors: { upload_failed: 2 } }],
  parses: [],
  unsupported_flavors: [],
  snapshot_age: [{ tool: "wow_get_state", reads: 40, p50: 90, p90: 1800, p99: 7200 }],
  tools: [],
  sections: [],
  issues: { total: 1, notes: [{ created_at: "2026-09-24T12:00:00.000Z", kit: "wow", agent_client: "DCR: Test agent", note: "Wrong trainer." }] },
  cap_hits: [],
  storage: { database_bytes: 8_000_000, tables: [{ table: "events", bytes: 2_000_000, rows: 5000 }] },
};

/** Renders `/admin` for a signed-in user whose metrics request `answer` answers. */
function render(answer: (url: string) => Response): { container: HTMLElement; requests: string[] } {
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url === "/api/v1/me") return Response.json(ME);
    if (url.startsWith("/api/v1/admin/metrics")) return answer(url);
    return Response.json({ error: "not_found" }, { status: 404 });
  });
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  root.render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/admin"]}>
        <AppRoutes />
      </MemoryRouter>
    </SessionProvider>,
  );
  return { container, requests };
}

it("is the Page not found page for anyone but an admin", async () => {
  const { container } = render(() => Response.json({ error: "not_found" }, { status: 404 }));
  await vi.waitFor(() => expect(container.querySelector("h1")?.textContent).toBe("Page not found"));
  expect(container.textContent).not.toContain("Admin");
});

it("shows an admin the metrics of the window, and loads another window", async () => {
  const { container, requests } = render(() => Response.json(METRICS));
  await vi.waitFor(() => expect(container.querySelector("h1")?.textContent).toBe("Admin"));
  expect(requests).toContain("/api/v1/admin/metrics?days=7");
  const text = container.textContent ?? "";
  for (const shown of ["upload_failed 2", "30.0 min", "Wrong trainer.", "DCR: Test agent", "7.6 MB"]) {
    expect(text).toContain(shown);
  }

  const select = container.querySelector("select");
  if (select === null) throw new Error("no window select");
  select.value = "30";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await vi.waitFor(() => expect(requests).toContain("/api/v1/admin/metrics?days=30"));
});
