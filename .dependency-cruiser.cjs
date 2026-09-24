// Package seams (docs/architecture.md §5), checked in CI by `pnpm lint:seams`.
// Any import from one package into another that these rules do not allow
// fails the build. scripts/check-workspace-deps.mjs checks the package.json
// declarations.
//
// An import by package name shows up in one of two forms: a path in the repo
// (the package resolved through its node_modules link), or the bare @ogmcp/*
// name when the package does not resolve (not declared, or not built yet).
// The package rules match both forms.

// The one platform module that may import kits (§5). RED-311 creates it.
const KIT_REGISTRY = "^platform/src/kits/registry\\.ts$";

// Every package in the repo, by directory or by package name.
const ANY_PACKAGE = ["^(packages|kits)/[^/]+/", "^(platform|bridge)/", "^@ogmcp/"];
const SDK = ["^packages/sdk/", "^@ogmcp/sdk$"];
const KITS = ["^kits/[^/]+/", "^@ogmcp/kit-"];

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-relative-import-across-packages",
      comment:
        "A relative import stays inside its own package. Import an allowed package by its @ogmcp/* name (§5).",
      severity: "error",
      from: { path: "^((packages|kits)/[^/]+|platform)/" },
      to: { dependencyTypes: ["local"], pathNot: "^$1/" },
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
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
    },
  },
};
