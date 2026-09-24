// Package seams (docs/architecture.md §5). scripts/lint-seams.mjs runs these
// rules once per workspace package; `pnpm lint:seams` runs that script, and CI
// runs it after a build. Any import from one package into another that these
// rules do not allow fails the build. The script also checks package.json
// declarations and kit re-exports from the kit registry.
//
// An import by package name shows up in one of two forms: a path in the repo
// (the package resolved through its node_modules link), or the bare @ogmcp/*
// name when the package does not resolve (not declared, or not built yet).
// The package rules match both forms. Any other import that does not resolve
// fails, so that no import goes unchecked.

// The one platform module that may import kits (§5). RED-311 creates it.
// scripts/lint-seams.mjs names it too.
const KIT_REGISTRY = "^platform/src/kits/registry\\.ts$";

// A workspace package directory. $1 in a `to` pattern is the importer's own.
const PACKAGE = "^((packages|kits)/[^/]+|platform)/";
// Every package in the repo, by directory or by package name.
const ANY_PACKAGE = ["^(packages|kits)/[^/]+/", "^(platform|bridge)/", "^@ogmcp/"];
const SDK = ["^packages/sdk/", "^@ogmcp/sdk(/|$)"];
const KITS = ["^kits/[^/]+/", "^@ogmcp/kit-"];

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      // dependency-cruiser types a relative import, and an alias (tsconfig
      // `paths`, package.json `imports`) that resolves inside the repo, as local.
      name: "no-relative-or-alias-import-across-packages",
      comment:
        "A relative or aliased import stays inside its own package. Import an allowed package by its @ogmcp/* name (§5).",
      severity: "error",
      from: { path: PACKAGE },
      to: { dependencyTypes: ["local"], pathNot: "^$1/" },
    },
    {
      name: "no-unresolved-import",
      comment:
        "Every import must resolve, so the seam rules can check where it points. Only an @ogmcp/* package that is not built yet is exempt (§5).",
      severity: "error",
      from: { path: PACKAGE },
      to: { couldNotResolve: true, pathNot: "^@ogmcp/" },
    },
    {
      name: "sdk-imports-no-package",
      comment: "packages/sdk depends on nothing in the repo (§5).",
      severity: "error",
      from: { path: "^packages/sdk/" },
      to: {
        dependencyTypesNot: ["local"],
        path: ANY_PACKAGE,
        pathNot: SDK,
      },
    },
    {
      name: "kit-imports-sdk-only",
      comment: "A kit depends on @ogmcp/sdk only (§5).",
      severity: "error",
      from: { path: "^kits/([^/]+)/" },
      to: {
        dependencyTypesNot: ["local"],
        path: ANY_PACKAGE,
        pathNot: ["^kits/$1/", ...SDK],
      },
    },
    {
      name: "platform-imports-sdk-only",
      comment:
        "Platform depends on @ogmcp/sdk only. Kits are imported only in platform/src/kits/registry.ts (§5).",
      severity: "error",
      from: { path: "^platform/", pathNot: KIT_REGISTRY },
      to: {
        dependencyTypesNot: ["local"],
        path: ANY_PACKAGE,
        pathNot: ["^platform/", ...SDK],
      },
    },
    {
      name: "kit-registry-imports-sdk-and-kits-only",
      comment: "The kit registry depends on @ogmcp/sdk and on kits only (§5).",
      severity: "error",
      from: { path: KIT_REGISTRY },
      to: {
        dependencyTypesNot: ["local"],
        path: ANY_PACKAGE,
        pathNot: ["^platform/", ...SDK, ...KITS],
      },
    },
  ],
  options: {
    // Type-only imports cross a seam too.
    tsPreCompilationDeps: true,
    // Record imports of dependencies and of build output, but do not scan them.
    doNotFollow: { path: ["(^|/)node_modules/", "(^|/)dist/"] },
    // scripts/lint-seams.mjs sets this to the package's own tsconfig.json, so
    // imports through its `paths` resolve.
    ...(process.env.SEAMS_TSCONFIG && { tsConfig: { fileName: process.env.SEAMS_TSCONFIG } }),
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
    },
  },
};
