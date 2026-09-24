// Adapter zips (docs/architecture.md §5, §8.2). At build time the platform
// zips each kit's `adapter/` folder and records the zip's sha256; at startup
// the registry reads both back. The bridge verifies the sha256 before it
// installs the zip (§7).
//
// Adapted from bttf/wow-guide@df80260 cloud/src/addonPackage.ts and
// cloud/src/buildAddon.ts.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

import type { CheckedKit } from "./validate.js";

/** Where the build writes the zips: `platform/dist/adapters`. */
export const ADAPTERS_DIR = fileURLToPath(new URL("../adapters", import.meta.url));

/** One kit's adapter zip, as the registry serves it. */
export interface AdapterZip {
  /** The folder the zip holds, e.g. `OpenGamerMCP`. */
  folder: string;
  /** The zip file. */
  path: string;
  /** Lower-case hex SHA-256 of the zip. */
  sha256: string;
  /** Bytes of the zip. */
  size: number;
}

/** What the build records next to `<kit>.zip`, as `<kit>.json`. */
interface AdapterRecord {
  folder: string;
  sha256: string;
}

/**
 * Zips each kit's `adapter/` folder into `outDir` as `<kit>.zip`, with its
 * record as `<kit>.json`. Empties `outDir` first, so a removed kit leaves no
 * zip behind. Skips adapter-less kits.
 */
export function writeAdapterZips(kits: readonly CheckedKit[], outDir: string): AdapterZip[] {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const zips: AdapterZip[] = [];
  for (const { source, manifest, adapterFolder } of kits) {
    if (adapterFolder === null) continue;
    const zip = zipAdapter(source.adapterDir, adapterFolder);
    const path = join(outDir, `${manifest.kit}.zip`);
    const record: AdapterRecord = { folder: adapterFolder, sha256: sha256(zip) };
    writeFileSync(path, zip);
    writeFileSync(join(outDir, `${manifest.kit}.json`), `${JSON.stringify(record, null, 2)}\n`);
    zips.push({ ...record, path, size: zip.length });
  }
  return zips;
}

/**
 * Reads the zip the build wrote for `kit` from `dir`. Throws when it is
 * missing, when its bytes do not match the recorded sha256, or when it holds
 * another folder than the manifest names. It does not compare the zip with
 * the kit's `adapter/` folder: the build that made `dir` is the pin (§5).
 */
export function readAdapterZip(dir: string, kit: string, folder: string): AdapterZip {
  const path = join(dir, `${kit}.zip`);
  let record: AdapterRecord;
  let zip: Buffer;
  try {
    record = JSON.parse(readFileSync(join(dir, `${kit}.json`), "utf8")) as AdapterRecord;
    zip = readFileSync(path);
  } catch {
    throw new Error(`no adapter zip for kit "${kit}" in ${dir}. The platform build makes it.`);
  }
  if (record.sha256 !== sha256(zip) || record.folder !== folder) {
    throw new Error(`the adapter zip for kit "${kit}" in ${dir} does not match its record or the manifest. Rebuild the platform.`);
  }
  return { folder, path, sha256: record.sha256, size: zip.length };
}

/**
 * Zips the files that ship in `adapterDir`, each under `folder/`. Dotfiles,
 * dot-folders, test folders (`test`, `tests`), and test files (`*_test.*`,
 * `*.test.*`, `*.spec.*`) stay out. A link or other special file, or a name
 * with `\` or `:`, fails the build: the bridge refuses links and paths that
 * leave the folder (§7).
 *
 * The zip is the same bytes for the same files: entries are sorted, every
 * entry has the same time and mode, and entries are stored, not deflated, so
 * the bytes do not depend on the zlib build.
 */
export function zipAdapter(adapterDir: string, folder: string): Buffer {
  const files = shippedFiles(adapterDir, "").sort();
  if (files.length === 0) throw new Error(`${adapterDir} holds no adapter files`);
  return writeZip(files.map((file) => ({ name: `${folder}/${file}`, data: readFileSync(join(adapterDir, file)) })));
}

const TEST_DIR = /^tests?$/;
const TEST_FILE = /(_test|\.test|\.spec)\.[^.]+$/;
/** A separator or drive on Windows: `a\..\..\x.lua` would leave the folder there. */
const UNSAFE_NAME = /[\\:]/;

/** The shipped files under `dir`, as `/`-separated paths relative to the adapter folder. */
function shippedFiles(root: string, dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (UNSAFE_NAME.test(entry.name)) {
      throw new Error(`${join(root, path)}: a name with "\\" or ":" is a path or drive on Windows, and the bridge refuses it (§7)`);
    }
    if (entry.isDirectory()) {
      if (!TEST_DIR.test(entry.name)) files.push(...shippedFiles(root, path));
    } else if (entry.isFile()) {
      if (!TEST_FILE.test(entry.name)) files.push(path);
    } else {
      throw new Error(`${join(root, path)} is not a regular file or folder; an adapter holds only those`);
    }
  }
  return files;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// 1980-01-01 00:00:00, the earliest DOS time, on every entry.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
// Made by Unix (3), zip spec 2.0, so the upper external attribute bits are a mode.
const MADE_BY = (3 << 8) | 20;
// Zip spec 1.0 extracts a stored entry.
const NEEDED = 10;
const STORED = 0;
// A regular file, rw-r--r--.
const FILE_MODE = 0o100644;
// Bit 11: the name is UTF-8.
const FLAGS = 1 << 11;

/**
 * A zip of regular files, stored, with fixed times and modes. No zip64: an
 * adapter is far below 4 GB and 65,535 files, and a larger one throws.
 */
export function writeZip(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(NEEDED, 4);
    local.writeUInt16LE(FLAGS, 6);
    local.writeUInt16LE(STORED, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, entry.data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(MADE_BY, 4);
    header.writeUInt16LE(NEEDED, 6);
    header.writeUInt16LE(FLAGS, 8);
    header.writeUInt16LE(STORED, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(entry.data.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // comment
    header.writeUInt16LE(0, 34); // disk
    header.writeUInt16LE(0, 36); // internal attributes
    header.writeUInt32LE((FILE_MODE << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + entry.data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, ...central, end]);
}
