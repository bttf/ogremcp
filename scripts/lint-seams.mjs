// Package seam checks (docs/architecture.md §5). Run it with `pnpm lint:seams`.
//
// 1. Each package.json declares only the workspace dependencies §5 allows,
//    each through a plain workspace: spec.
// 2. The kit registry does not re-export a kit.
// 3. dependency-cruiser checks each package's imports against
//    .dependency-cruiser.cjs, with that package's tsconfig.json.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";

// Package name -> the workspace packages it may declare (§5). A package with
// no entry here fails the check until it gets one.
const ALLOWED = [
  [/^@ogremcp\/sdk$/, []],
  [/^@ogremcp\/kit-/, [/^@ogremcp\/sdk$/]],
  [/^@ogremcp\/platform$/, [/^@ogremcp\/sdk$/, /^@ogremcp\/kit-/]],
];
// The one platform module that may import kits. .dependency-cruiser.cjs names
// it too.
const KIT_REGISTRY = "platform/src/kits/registry.ts";
const KIT = /^@ogremcp\/kit-/;

const FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
// The only specs allowed for a workspace dependency. An alias such as
// workspace:@ogremcp/platform@* would link another package under an allowed name.
const WORKSPACE_SPEC = /^workspace:[*^~]$/;
const PATH_SPEC = /^(?:link|file):(.*)$/;

const root = process.cwd();
const packages = JSON.parse(
  execFileSync("pnpm", ["ls", "-r", "--depth", "-1", "--json"], { encoding: "utf8" }),
).filter((pkg) => pkg.path !== root);
const names = new Set(packages.map((pkg) => pkg.name));

let failed = false;
function fail(message) {
  console.error(message);
  failed = true;
}

function inRepo(path) {
  const rel = relative(root, path);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

// 1. Declarations.
for (const pkg of packages) {
  const manifest = JSON.parse(readFileSync(join(pkg.path, "package.json"), "utf8"));
  const rule = ALLOWED.find(([name]) => name.test(pkg.name));
  if (!rule) {
    fail(`${pkg.name}: no seam rule. Add one to scripts/lint-seams.mjs and .dependency-cruiser.cjs.`);
    continue;
  }
  for (const field of FIELDS) {
    for (const [dep, spec] of Object.entries(manifest[field] ?? {})) {
      const path = PATH_SPEC.exec(spec)?.[1];
      if (path !== undefined && inRepo(resolve(pkg.path, path))) {
        fail(`${pkg.name}: ${field} links ${dep} to a path in the repo (${spec}). Use a workspace: spec.`);
      } else if (names.has(dep) || dep.startsWith("@ogremcp/") || spec.startsWith("workspace:") || spec.includes("@ogremcp/")) {
        if (!WORKSPACE_SPEC.test(spec)) {
          fail(`${pkg.name}: ${field} declares ${dep} as ${spec}. Use workspace:*, workspace:^, or workspace:~.`);
        } else if (!rule[1].some((allowed) => allowed.test(dep))) {
          fail(`${pkg.name}: ${field} declares ${dep}, which §5 does not allow.`);
        }
      }
    }
  }
}
if (!failed) console.log(`Workspace dependencies follow §5 in ${packages.length} packages.`);

// 2. The registry types each kit as an Interpreter (§5), so it must not pass a
// kit on whole: no `export ... from "@ogremcp/kit-*"`, and no `export { name }`
// or `export default name` of a name imported from a kit. It imports a kit's
// exports by name: no `import * as`, and a default import only of a kit's
// JSON file, which has no named exports.
if (existsSync(KIT_REGISTRY)) {
  const source = ts.createSourceFile(KIT_REGISTRY, readFileSync(KIT_REGISTRY, "utf8"), ts.ScriptTarget.Latest);
  const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const kitNames = new Set();
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node) && KIT.test(node.moduleSpecifier.text) && node.importClause) {
      const { name, namedBindings } = node.importClause;
      const whole =
        (namedBindings && ts.isNamespaceImport(namedBindings)) || (name && !node.moduleSpecifier.text.endsWith(".json"));
      if (whole) {
        fail(`${KIT_REGISTRY}:${lineOf(node)}: imports a kit module whole. Import the kit's exports by name (§5).`);
      }
      if (name) kitNames.add(name.text);
      if (namedBindings && ts.isNamespaceImport(namedBindings)) kitNames.add(namedBindings.name.text);
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) kitNames.add(element.name.text);
      }
    }
  }
  for (const node of source.statements) {
    const reExport =
      ts.isExportDeclaration(node) &&
      (node.moduleSpecifier
        ? KIT.test(node.moduleSpecifier.text)
        : node.exportClause !== undefined &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.some((element) => kitNames.has((element.propertyName ?? element.name).text)));
    const defaultExport = ts.isExportAssignment(node) && ts.isIdentifier(node.expression) && kitNames.has(node.expression.text);
    if (reExport || defaultExport) {
      fail(`${KIT_REGISTRY}:${lineOf(node)}: re-exports a kit. The registry exports each kit as an Interpreter (§5).`);
    }
  }
}

// 3. Imports. When a tsconfig has `paths` but no baseUrl, TypeScript resolves
// the paths against the directory of the tsconfig that sets them, while
// dependency-cruiser resolves them against the working directory. For such a
// package, dependency-cruiser gets a tsconfig that extends the package's and
// sets baseUrl to that directory.
const tmp = mkdtempSync(join(tmpdir(), "ogremcp-seams-"));
try {
  for (const pkg of packages) {
    let tsconfig = join(pkg.path, "tsconfig.json");
    const options = existsSync(tsconfig)
      ? ts.getParsedCommandLineOfConfigFile(tsconfig, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} })?.options
      : undefined;
    if (!options) {
      tsconfig = "";
    } else if (options.paths && !options.baseUrl) {
      const wrapper = join(tmp, `${pkg.name.replace("/", "_")}.tsconfig.json`);
      const compilerOptions = { baseUrl: options.pathsBasePath, paths: options.paths };
      writeFileSync(wrapper, JSON.stringify({ extends: tsconfig, compilerOptions }));
      tsconfig = wrapper;
    }
    const cruise = spawnSync("pnpm", ["exec", "depcruise", "--output-type", "err-long", relative(root, pkg.path)], {
      env: { ...process.env, SEAMS_TSCONFIG: tsconfig },
      stdio: "inherit",
    });
    if (cruise.status !== 0) failed = true;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failed) process.exit(1);
