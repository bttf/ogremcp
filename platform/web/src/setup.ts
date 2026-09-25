/** What `GET /api/v1/setup` answers (`Setup` in `platform/src/api.ts`). */
export interface Setup {
  /** The one URL every agent connects to (§1, §9). */
  mcp_url: string;
  /** Where to download the bridge, or null when there is no download yet. */
  bridge_download_url: string | null;
}

/** The links of the Get started and Connect your agent pages, or null when the service did not answer them. */
export async function loadSetup(): Promise<Setup | null> {
  try {
    const res = await fetch("/api/v1/setup", { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as Setup;
  } catch {
    return null;
  }
}
