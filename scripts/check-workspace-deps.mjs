// Fails if a workspace package declares a workspace dependency that
// docs/architecture.md §5 does not allow. `.dependency-cruiser.cjs` checks the
// imports themselves. Run it with `pnpm lint:seams`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Package name -> the workspace packages it may declare (§5). A package with
// no entry here fails the check until it gets one.
const ALLOWED = [
  [/^@ogmcp\/sdk$/, []],
  [/^@ogmcp\/kit-/, [/^@ogmcp\/sdk$/]],
  [/^@ogmcp\/platform$/, [/^@ogmcp\/sdk$/, /^@ogmcp\/kit-/]],
];

const FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
// Specs that point at a path in the repo rather than at the registry.
const LOCAL_SPEC = /^(workspace|link|file):/;

const root = process.cwd();
const packages = JSON.parse(
  execFileSync("pnpm", ["ls", "-r", "--depth", "-1", "--json"], { encoding: "utf8" }),
).filter((pkg) => pkg.path !== root);
const names = new Set(packages.map((pkg) => pkg.name));

let failed = false;
for (const pkg of packages) {
  const manifest = JSON.parse(readFileSync(join(pkg.path, "package.json"), "utf8"));
  const rule = ALLOWED.find(([name]) => name.test(pkg.name));
  if (!rule) {
    console.error(`${pkg.name}: no seam rule. Add one to scripts/check-workspace-deps.mjs and .dependency-cruiser.cjs.`);
    failed = true;
    continue;
  }
  for (const field of FIELDS) {
    for (const [dep, spec] of Object.entries(manifest[field] ?? {})) {
      const inRepo = names.has(dep) || dep.startsWith("@ogmcp/") || LOCAL_SPEC.test(spec);
      if (inRepo && !rule[1].some((allowed) => allowed.test(dep))) {
        console.error(`${pkg.name}: ${field} declares ${dep} (${spec}), which §5 does not allow.`);
        failed = true;
      }
    }
  }
}

if (failed) process.exit(1);
console.log(`Workspace dependencies follow §5 in ${packages.length} packages.`);
