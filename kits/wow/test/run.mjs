// Runs the adapter's Lua tests (test/adapter_test.lua) under LuaJIT.
//
//   node test/run.mjs [out-dir]
//
// The tests write a SavedVariables file per stub client. With out-dir they are
// kept there; otherwise they go to a temporary directory that is removed.
// Needs `luajit` on PATH.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const keep = process.argv[2];
const out = keep ? resolve(keep) : mkdtempSync(join(tmpdir(), "ogmcp-adapter-"));

let status = 1;
try {
  const result = spawnSync("luajit", [join(here, "adapter_test.lua"), out], { stdio: "inherit" });
  if (result.error?.code === "ENOENT") {
    console.error("The adapter tests need luajit on PATH. Install it with: brew install luajit");
  } else if (result.error) {
    throw result.error;
  } else {
    status = result.status ?? 1;
  }
} finally {
  if (!keep) {
    rmSync(out, { recursive: true, force: true });
  }
}
process.exit(status);
