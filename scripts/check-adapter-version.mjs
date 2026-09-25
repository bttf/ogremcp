// Adapter version check (docs/architecture.md §7, §8.2). The bridge installs a
// kit's adapter only when the platform's version is newer, and never
// downgrades, so an adapter change that keeps its version never reaches an
// installed addon. This fails when the branch changes any file under
// kits/<kit>/adapter/ without raising that kit's TOC `## Version` above the
// one on <base-ref>. Changed files come from `git diff <base-ref>...HEAD`, so
// commit first. CI runs it on pull requests with the PR's base commit; run it
// locally with `node scripts/check-adapter-version.mjs origin/main`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const base = process.argv[2];
if (!base) {
  console.error("usage: node scripts/check-adapter-version.mjs <base-ref>");
  process.exit(2);
}

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

// The semver that manifests and TOCs use, from the SDK's manifest schema.
const schema = JSON.parse(readFileSync(join(root, "packages/sdk/src/manifest.schema.json"), "utf8"));
const SEMVER = new RegExp(schema.properties.version.pattern);
const TOC_VERSION = /^##\s*Version:(.*)$/;
const ADAPTER = /^kits\/([^/]+)\/adapter\//;

/** The `## Version` of the kit's adapter TOCs at `ref`, or undefined if it has none. */
function tocVersion(ref, kit) {
  const dir = `kits/${kit}/adapter/`;
  const tocs = git("ls-tree", "-z", "--name-only", ref, "--", dir)
    .split("\0")
    .filter((path) => {
      const name = path.slice(dir.length);
      return name && !name.startsWith(".") && name.toLowerCase().endsWith(".toc");
    });
  const versions = new Set(
    tocs.flatMap((path) =>
      git("show", `${ref}:${path}`)
        .replace(/^﻿/, "")
        .split(/\r?\n/)
        .flatMap((line) => TOC_VERSION.exec(line.trim())?.[1]?.trim() ?? []),
    ),
  );
  if (versions.size === 0) return undefined;
  const [version] = versions;
  if (versions.size > 1 || !SEMVER.test(version)) {
    throw new Error(`${dir} at ${ref}: the .toc files must name one semver "## Version:" (§8.2)`);
  }
  return version;
}

/** Semver precedence: negative, zero, or positive as `a` is lower, equal, or higher. */
function compareSemver(a, b) {
  const parse = (v) => {
    const dash = v.indexOf("-");
    const core = (dash < 0 ? v : v.slice(0, dash)).split(".").map(Number);
    return [core, dash < 0 ? [] : v.slice(dash + 1).split(".")];
  };
  const [coreA, preA] = parse(a);
  const [coreB, preB] = parse(b);
  for (let i = 0; i < 3; i++) if (coreA[i] !== coreB[i]) return coreA[i] - coreB[i];
  // A release outranks its pre-releases.
  if (preA.length === 0 || preB.length === 0) return preB.length - preA.length;
  for (let i = 0; i < Math.min(preA.length, preB.length); i++) {
    const x = preA[i];
    const y = preB[i];
    if (x === y) continue;
    const numX = /^\d+$/.test(x);
    const numY = /^\d+$/.test(y);
    if (numX && numY) return Number(x) - Number(y);
    if (numX !== numY) return numX ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return preA.length - preB.length;
}

const kits = new Set(
  git("diff", "-z", "--name-only", "--no-renames", `${base}...HEAD`)
    .split("\0")
    .flatMap((path) => ADAPTER.exec(path)?.[1] ?? []),
);
if (kits.size === 0) console.log("No adapter changes.");

let failed = false;
for (const kit of [...kits].sort()) {
  const before = tocVersion(base, kit);
  const after = tocVersion("HEAD", kit);
  if (after === undefined) {
    console.error(`kits/${kit}/adapter/ changed and has no .toc with a "## Version:" line (§8.2).`);
    failed = true;
  } else if (before !== undefined && compareSemver(after, before) <= 0) {
    console.error(
      `kits/${kit}/adapter/ changed but its TOC ## Version is ${after}, not above ${before} on ${base}. ` +
        `Raise it, or the bridge never installs the change (§7).`,
    );
    failed = true;
  } else {
    console.log(`kits/${kit}/adapter/: ${before ?? "new"} -> ${after}`);
  }
}
if (failed) process.exit(1);
