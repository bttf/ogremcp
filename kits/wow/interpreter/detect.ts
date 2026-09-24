// Flavor and rules detection (docs/architecture.md §6.3.1).
import type { Client } from "./schema.js";

export interface Detection {
  /** A flavor key, e.g. "classic_era", or "unknown". */
  flavor: string;
  /** E.g. ["hardcore"]; [] on normal realms. */
  rules: string[];
}

/**
 * Maps the adapter's raw client facts to a flavor and rules. `client` is null
 * when the adapter could not read them.
 *
 * RED-292 implements the §6.3.1 table here. Until then every upload maps to
 * "unknown", which ingest rejects as `unsupported_flavor` (§8.3).
 */
export function detect(client: Client | null): Detection {
  return { flavor: "unknown", rules: [] };
}
