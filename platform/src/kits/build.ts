// Zips each first-class kit's `adapter/` into `dist/adapters` and records its
// sha256 (docs/architecture.md §5, §8.2). The platform's `build` script runs
// it after tsc, so a deploy serves the adapters of the commit it was built
// from. It checks every kit first, so a bad kit fails the build.
//
// Adapted from bttf/wow-guide@df80260 cloud/src/buildAddon.ts.
import { ADAPTERS_DIR, writeAdapterZips } from "./adapter.js";
import { KIT_SOURCES } from "./registry.js";
import { checkKits } from "./validate.js";

try {
  for (const zip of writeAdapterZips(checkKits(KIT_SOURCES), ADAPTERS_DIR)) {
    console.log(`adapter zipped: ${zip.path} (${zip.folder}/, ${zip.size} bytes, sha256 ${zip.sha256})`);
  }
} catch (err) {
  console.error(`adapter zip failed: ${(err as Error).message}`);
  process.exit(1);
}
