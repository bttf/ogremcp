#!/usr/bin/env node
// Builds the BG1 kit's name tables in kits/bg1/data/ from a Baldur's Gate:
// Enhanced Edition install (docs/architecture.md §6.6.3, §19.1 D13). A
// maintainer runs it by hand, and again when a game patch changes the text.
// CI never runs it.
//
// Usage: node kits/bg1/scripts/extract-tables.mjs <install> [--game-version <version>]
//
// <install> is the folder that holds chitin.key. The game version comes from
// CFBundleShortVersionString in the macOS app's Info.plist; pass
// --game-version for an install without one.
//
// It reads lang/en_US/dialog.tlk, chitin.key and the BIFF archives, override/
// when present, BGEE.LUA, and the IDS and 2DA files named below. It writes, with
// sorted keys and one entry per line so that a re-run diffs cleanly:
//
//   strings.json  { "<strref>": "<text>" }: the text of every strref the other
//                 tables name, every strref the journal can show, and the long
//                 names (CRE 0x08) of the characters who can join the party
//                 (PDIALOG.2DA rows, matched to CRE files by their death
//                 variable). The journal shows the quest list, DLG transitions
//                 with a journal entry, the journal actions in DLG and BCS
//                 scripts, and notes: the player can copy the description
//                 (ITM 0x50, 0x54) of a scroll without abilities to the journal.
//   quests.json   [{ "title": <strref>, "entries": [<strref>, ...] }]: the quest
//                 list from buildQuestsTable in BGEE.LUA, in the game's order.
//                 An entry's first line is its objective (UTIL.LUA createEntry).
//   items.json    { "<RESREF>": { "name": <strref>|null, "unidentified": <strref>|null } }
//                 (ITM V1 0x0c and 0x08; null when the strref has no text).
//   spells.json   { "<RESREF>": <strref> } (SPL V1 0x08).
//   areas.json    { "<RESREF>": "<name>" }: the cheatAreas list in BGEE.LUA,
//                 without its parenthetical notes, which name characters.
//   options.json  { "alignment" | "class" | "gender" | "kit" | "race": { "<id>": "<name>" } }
//                 Class: CLASTEXT.2DA MIXED of each class without a kit, with
//                 the engine's tokens <FIGHTERTYPE> and <MAGESCHOOL> read as
//                 "Fighter" and "Mage". Race: RACETEXT.2DA UPPERCASE. Kit:
//                 KITLIST.2DA MIXED, keyed by its KITIDS value (KIT.IDS).
//                 Alignment and gender have no text table: their names are the
//                 ALIGNMEN.IDS and GENDER.IDS symbols in title case.
//   meta.json     { "gameVersion": "<version>", "language": "en_US" }
//
// Items, spells, and strings with no text are left out. Resrefs are upper case.
// Text is UTF-8 as the game stores it, including tokens such as <CHARNAME>,
// with U+0000 read as U+FFFD.
//
// Kit IDs are KIT.IDS values. A CRE (0x244) stores one with its two 16-bit
// halves swapped: kit = u16(0x246) | u16(0x244) << 16. A kit of 0 or 0x4000
// (TRUECLASS) is no kit.
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const LANGUAGE = "en_US";
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

// Resource types (IESDP), and the file extension of each in override/.
const TYPE = { itm: 0x3ed, spl: 0x3ee, bcs: 0x3ef, ids: 0x3f0, cre: 0x3f1, dlg: 0x3f3, "2da": 0x3f4, lua: 0x409 };

// The script actions that add, finish, or remove a journal entry. Their first
// parameter is the entry's strref (ACTION.IDS).
const JOURNAL_ACTIONS = ["AddJournalEntry", "EraseJournalEntry", "SetQuestDone"];
const DLG_HAS_JOURNAL = 0x10;
const ITM_SCROLL = 11;
// What the engine puts in place of these tokens for a character without a kit.
const CLASS_TOKENS = { FIGHTERTYPE: "Fighter", MAGESCHOOL: "Mage" };
const NO_KIT = new Set([0, 0x4000]);

const warnings = [];
const warn = (message) => warnings.push(message);

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "game-version": { type: "string" } },
  });
  if (positionals.length !== 1) {
    console.error("usage: node kits/bg1/scripts/extract-tables.mjs <install> [--game-version <version>]");
    process.exit(2);
  }
  const install = positionals[0];
  const gameVersion = values["game-version"] ?? appVersion(install);

  const tlk = readTlk(findPath(install, `lang/${LANGUAGE}/dialog.tlk`));
  const res = new Resources(install);
  try {
    const lua = res.text("BGEE", TYPE.lua);
    const quests = questList(lua);
    const areas = areaNames(lua);
    const { items, notes } = itemNames(res, tlk);
    const spells = spellNames(res, tlk);
    const journal = journalStrrefs(res, quests, notes);
    const creatures = joinableNames(res);
    const options = characterOptions(res, tlk);

    const strrefs = new Set([
      ...journal,
      ...creatures,
      ...Object.values(items).flatMap((item) => [item.name, item.unidentified]),
      ...Object.values(spells),
    ]);
    const strings = {};
    let missing = 0;
    for (const strref of [...strrefs].filter((s) => s !== null).sort((a, b) => a - b)) {
      const text = tlk.text(strref);
      if (text === undefined) missing++;
      else strings[strref] = text;
    }
    if (missing) warn(`${missing} journal or creature strrefs have no text; left out of strings.json`);
    for (const quest of quests) {
      for (const strref of [quest.title, ...quest.entries]) {
        if (!(strref in strings)) warn(`quest list: strref ${strref} has no text`);
      }
    }

    const files = {
      "strings.json": objectLines(strings),
      "quests.json": arrayLines(quests),
      "items.json": objectLines(sortKeys(items)),
      "spells.json": objectLines(sortKeys(spells)),
      "areas.json": objectLines(sortKeys(areas)),
      "options.json": `${JSON.stringify(options, null, 2)}\n`,
      "meta.json": `${JSON.stringify({ gameVersion, language: LANGUAGE }, null, 2)}\n`,
    };
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(OUT_DIR, name), content);
      console.log(`${name}: ${Buffer.byteLength(content)} bytes`);
    }
    console.log(
      `${quests.length} quests, ${quests.reduce((n, q) => n + q.entries.length, 0)} quest entries, ` +
        `${journal.size} journal strrefs, ${Object.keys(items).length} items, ${Object.keys(spells).length} spells, ` +
        `${Object.keys(areas).length} areas, ${creatures.size} joinable-creature names, game ${gameVersion}`,
    );
  } finally {
    res.close();
  }
  for (const message of warnings) console.warn(`warning: ${message}`);
}

// ---------- tables ----------

/** buildQuestsTable in BGEE.LUA: createQuest(title) and createEntry(title, objective, entry, ...). */
function questList(lua) {
  const body = /^function buildQuestsTable\(\)\s*$([\s\S]*?)^end\s*$/m.exec(lua)?.[1];
  if (body === undefined) throw new Error("BGEE.LUA: no buildQuestsTable");
  const quests = [];
  const byTitle = new Map();
  for (const raw of body.split("\n")) {
    const line = raw.replace(/--.*$/, "");
    let m;
    if ((m = /^\s*createQuest\s*\(\s*(\d+)\s*\)\s*$/.exec(line))) {
      const title = Number(m[1]);
      if (byTitle.has(title)) throw new Error(`BGEE.LUA: quest ${title} created twice`);
      const quest = { title, entries: [] };
      byTitle.set(title, quest);
      quests.push(quest);
    } else if ((m = /^\s*createEntry\s*\(\s*(\d+)\s*,\s*-?\d+\s*,\s*(\d+)\s*,/.exec(line))) {
      const quest = byTitle.get(Number(m[1]));
      if (!quest) throw new Error(`BGEE.LUA: entry ${m[2]} names quest ${m[1]}, which is not created before it`);
      quest.entries.push(Number(m[2]));
    } else if (/\bcreate\w*\s*\(/.test(line)) {
      throw new Error(`BGEE.LUA: unexpected line in buildQuestsTable: ${line.trim()}`);
    }
  }
  if (quests.length === 0) throw new Error("BGEE.LUA: buildQuestsTable creates no quests");
  return quests;
}

/** The cheatAreas list in BGEE.LUA, without parenthetical notes. */
function areaNames(lua) {
  const block = /^cheatAreas\s*=\s*\{\s*$([\s\S]*?)^\}\s*$/m.exec(lua)?.[1];
  if (block === undefined) throw new Error("BGEE.LUA: no cheatAreas");
  const areas = {};
  for (const m of block.matchAll(/\{\s*"([^"]+)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\}/g)) {
    const code = m[1].toUpperCase();
    let name = m[2].replace(/\\(.)/g, "$1");
    for (let prev; prev !== name; ) {
      prev = name;
      name = name.replace(/\s*\([^()]*\)/g, "");
    }
    name = name.replace(/\s+/g, " ").trim();
    if (code in areas) {
      if (areas[code] !== name) warn(`cheatAreas: ${code} listed twice; kept "${areas[code]}", not "${name}"`);
      continue;
    }
    if (!name) throw new Error(`cheatAreas: ${code} has no name without its notes`);
    areas[code] = name;
  }
  if (Object.keys(areas).length === 0) throw new Error("BGEE.LUA: cheatAreas is empty");
  return areas;
}

/**
 * ITM V1: unidentified name at 0x08, identified name at 0x0c. Notes are the
 * descriptions (0x50 unidentified, 0x54 identified) of scrolls (item type 11
 * at 0x1c) with no ability headers (count at 0x68): the game offers to copy
 * such a scroll to the journal (IESDP, ITM V1).
 */
function itemNames(res, tlk) {
  const items = {};
  const notes = new Set();
  for (const name of res.names(TYPE.itm)) {
    const b = res.get(name, TYPE.itm);
    if (!hasSignature(b, "ITM V1  ", 0x72)) {
      warn(`${name}.ITM: not ITM V1; skipped`);
      continue;
    }
    const item = { name: textRef(tlk, b.readUInt32LE(0x0c)), unidentified: textRef(tlk, b.readUInt32LE(0x08)) };
    if (item.name !== null || item.unidentified !== null) items[name] = item;
    if (b.readUInt16LE(0x1c) === ITM_SCROLL && b.readUInt16LE(0x68) === 0) {
      for (const strref of [b.readUInt32LE(0x50), b.readUInt32LE(0x54)]) {
        if (textRef(tlk, strref) !== null) notes.add(strref);
      }
    }
  }
  return { items, notes };
}

/** SPL V1: name at 0x08. */
function spellNames(res, tlk) {
  const spells = {};
  for (const name of res.names(TYPE.spl)) {
    const b = res.get(name, TYPE.spl);
    if (!hasSignature(b, "SPL V1  ", 0x0c)) {
      warn(`${name}.SPL: not SPL V1; skipped`);
      continue;
    }
    const strref = textRef(tlk, b.readUInt32LE(0x08));
    if (strref !== null) spells[name] = strref;
  }
  return spells;
}

/** Every strref the journal can show. */
function journalStrrefs(res, quests, notes) {
  const strrefs = new Set([...quests.flatMap((quest) => [quest.title, ...quest.entries]), ...notes]);
  const add = (value) => {
    if (value >= 0 && value < 0xffffffff) strrefs.add(value);
  };

  // Journal actions in dialog actions, which DLG files keep as script source.
  const actionCall = new RegExp(`\\b(?:${JOURNAL_ACTIONS.join("|")})\\s*\\(\\s*(\\d+)`, "gi");
  for (const name of res.names(TYPE.dlg)) {
    const b = res.get(name, TYPE.dlg);
    if (!hasSignature(b, "DLG V1.0", 0x30)) {
      warn(`${name}.DLG: not DLG V1.0; skipped`);
      continue;
    }
    try {
      const [ntrans, otrans] = [b.readUInt32LE(0x10), b.readUInt32LE(0x14)];
      checkRange(b, otrans, ntrans * 0x20);
      for (let i = 0; i < ntrans; i++) {
        const e = otrans + i * 0x20;
        if (b.readUInt32LE(e) & DLG_HAS_JOURNAL) add(b.readUInt32LE(e + 0x08));
      }
      const [oact, nact] = [b.readUInt32LE(0x28), b.readUInt32LE(0x2c)];
      checkRange(b, oact, nact * 8);
      for (let i = 0; i < nact; i++) {
        const [off, len] = [b.readUInt32LE(oact + i * 8), b.readUInt32LE(oact + i * 8 + 4)];
        checkRange(b, off, len);
        for (const m of b.toString("latin1", off, off + len).matchAll(actionCall)) add(Number(m[1]));
      }
    } catch (err) {
      warn(`${name}.DLG: ${err.message}; skipped`);
    }
  }

  // Journal actions in compiled scripts. An action is
  // AC <id>OB <object>OB OB <object>OB OB <object>OB <int1> <x> <y> <int2> <int3>"<s1>" "<s2>" AC
  // and the entry's strref is <int1>.
  const ids = journalActionIds(res);
  const action = /AC\s*(\d+)\s*OB[^]*?OB\s*OB[^]*?OB\s*OB[^]*?OB\s*(-?\d+)/g;
  for (const name of res.names(TYPE.bcs)) {
    // Strings hold no quotes, and dropping them leaves "OB" and "AC" only as markers.
    const script = res.get(name, TYPE.bcs).toString("latin1").replace(/"[^"]*"/g, '""');
    for (const m of script.matchAll(action)) {
      if (ids.has(Number(m[1]))) add(Number(m[2]));
    }
  }
  return strrefs;
}

function journalActionIds(res) {
  const ids = new Set();
  const found = new Set();
  for (const line of res.text("ACTION", TYPE.ids).split("\n")) {
    const m = /^\s*(\d+)\s+(\w+)\s*\(([^)]*)\)/.exec(line);
    if (!m || !JOURNAL_ACTIONS.includes(m[2])) continue;
    if (!/^I:/.test(m[3])) throw new Error(`ACTION.IDS: ${m[2]} does not take a strref first`);
    ids.add(Number(m[1]));
    found.add(m[2]);
  }
  for (const name of JOURNAL_ACTIONS) if (!found.has(name)) throw new Error(`ACTION.IDS: no ${name}`);
  return ids;
}

/** Long names (CRE 0x08) of every CRE whose death variable is a PDIALOG.2DA row. */
function joinableNames(res) {
  const joinable = new Set(parse2da(res.text("PDIALOG", TYPE["2da"]), "PDIALOG.2DA").map((row) => row.name.toUpperCase()));
  const strrefs = new Set();
  const found = new Set();
  for (const name of res.names(TYPE.cre)) {
    const b = res.get(name, TYPE.cre);
    if (!hasSignature(b, "CRE V1.0", 0x2a0)) continue;
    const deathVar = cstring(b, 0x280, 32).toUpperCase();
    if (!joinable.has(deathVar)) continue;
    found.add(deathVar);
    const strref = b.readUInt32LE(0x08);
    if (strref < 0xffffffff) strrefs.add(strref);
  }
  for (const name of joinable) if (!found.has(name)) warn(`PDIALOG.2DA: no CRE has death variable ${name}`);
  return strrefs;
}

function characterOptions(res, tlk) {
  const need = (strref, where) => {
    const text = tlk.text(strref);
    if (text === undefined) throw new Error(`${where}: strref ${strref} has no text`);
    return text;
  };

  const classes = {};
  for (const row of parse2da(res.text("CLASTEXT", TYPE["2da"]), "CLASTEXT.2DA")) {
    if (Number(row.KITID) !== 0x4000 || row.FALLEN !== "0") continue;
    const id = Number(row.CLASSID);
    if (id in classes) continue;
    const name = need(Number(row.MIXED), `CLASTEXT.2DA ${row.name}`).replace(/<(\w+)>/g, (token, key) => {
      if (!(key in CLASS_TOKENS)) throw new Error(`CLASTEXT.2DA ${row.name}: unknown token ${token}`);
      return CLASS_TOKENS[key];
    });
    classes[id] = name;
  }

  const races = {};
  for (const row of parse2da(res.text("RACETEXT", TYPE["2da"]), "RACETEXT.2DA")) {
    const id = Number(row.ID);
    if (!(id in races)) races[id] = need(Number(row.UPPERCASE), `RACETEXT.2DA ${row.name}`);
  }

  const kits = {};
  for (const row of parse2da(res.text("KITLIST", TYPE["2da"]), "KITLIST.2DA")) {
    const id = Number(row.KITIDS);
    if (!Number.isInteger(id) || NO_KIT.has(id) || id in kits) continue;
    kits[id] = need(Number(row.MIXED), `KITLIST.2DA ${row.name}`);
  }

  const alignments = {};
  for (const [id, symbol] of parseIds(res.text("ALIGNMEN", TYPE.ids))) {
    if (!symbol.startsWith("MASK_") && !(id in alignments)) alignments[id] = titleCase(symbol);
  }
  const genders = {};
  for (const [id, symbol] of parseIds(res.text("GENDER", TYPE.ids))) {
    if (!(id in genders)) genders[id] = titleCase(symbol);
  }

  return {
    alignment: sortKeys(alignments),
    class: sortKeys(classes),
    gender: sortKeys(genders),
    kit: sortKeys(kits),
    race: sortKeys(races),
  };
}

// ---------- game files ----------

/** dialog.tlk (TLK V1). text(strref) is undefined for a strref without text. */
function readTlk(path) {
  const b = readFileSync(path);
  if (!hasSignature(b, "TLK V1  ", 0x12)) throw new Error(`${path}: not TLK V1`);
  const count = b.readUInt32LE(0x0a);
  const base = b.readUInt32LE(0x0e);
  checkRange(b, 0x12, count * 26);
  return {
    text(strref) {
      if (!Number.isInteger(strref) || strref < 0 || strref >= count) return undefined;
      const e = 0x12 + strref * 26;
      const [flags, off, len] = [b.readUInt16LE(e), b.readUInt32LE(e + 18), b.readUInt32LE(e + 22)];
      if (!(flags & 1) || len === 0) return undefined;
      checkRange(b, base + off, len);
      const text = clean(b.toString("utf8", base + off, base + off + len));
      // Strref 0 is the engine's placeholder for "no string".
      return strref === 0 && text === "<NO TEXT>" ? undefined : text;
    },
  };
}

/** chitin.key, the BIFF archives it indexes, and override/. */
class Resources {
  constructor(root) {
    this.root = root;
    this.bifs = [];
    this.entries = new Map(); // "NAME.type" -> { bif, index }
    this.override = new Map(); // "NAME.type" -> path
    this.open = new Map(); // bif index -> { fd, files }

    const key = readFileSync(findPath(root, "chitin.key"));
    if (!hasSignature(key, "KEY V1  ", 0x18)) throw new Error("chitin.key: not KEY V1");
    const [nbif, nres, obif, ores] = [key.readUInt32LE(8), key.readUInt32LE(12), key.readUInt32LE(16), key.readUInt32LE(20)];
    checkRange(key, obif, nbif * 12);
    checkRange(key, ores, nres * 14);
    for (let i = 0; i < nbif; i++) {
      const e = obif + i * 12;
      const [off, len] = [key.readUInt32LE(e + 4), key.readUInt16LE(e + 8)];
      checkRange(key, off, len);
      this.bifs.push(cstring(key, off, len));
    }
    for (let i = 0; i < nres; i++) {
      const e = ores + i * 14;
      const id = `${cstring(key, e, 8).toUpperCase()}.${key.readUInt16LE(e + 8)}`;
      const locator = key.readUInt32LE(e + 10);
      if (!this.entries.has(id)) this.entries.set(id, { bif: locator >>> 20, index: locator & 0x3fff });
    }

    const overrideDir = findPath(root, "override", false);
    if (overrideDir) {
      const types = new Map(Object.entries(TYPE));
      for (const file of readdirSync(overrideDir)) {
        const m = /^([^.]{1,8})\.([^.]+)$/.exec(file);
        const type = m && types.get(m[2].toLowerCase());
        if (type) this.override.set(`${m[1].toUpperCase()}.${type}`, join(overrideDir, file));
      }
    }
  }

  /** Every resource name of a type, sorted. */
  names(type) {
    const names = new Set();
    for (const id of [...this.entries.keys(), ...this.override.keys()]) {
      const dot = id.lastIndexOf(".");
      if (Number(id.slice(dot + 1)) === type) names.add(id.slice(0, dot));
    }
    return [...names].sort(compare);
  }

  get(name, type) {
    const id = `${name.toUpperCase()}.${type}`;
    const file = this.override.get(id);
    if (file) return readFileSync(file);
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const bif = this.bif(entry.bif);
    const at = bif.files.get(entry.index);
    if (!at) throw new Error(`${name}: not in ${this.bifs[entry.bif]}`);
    const b = Buffer.alloc(at.size);
    readSync(bif.fd, b, 0, at.size, at.offset);
    return b;
  }

  /** A text resource (IDS, 2DA, LUA) with CRLF line ends read as LF. */
  text(name, type) {
    const b = this.get(name, type);
    if (!b) throw new Error(`${name}: not found (type 0x${type.toString(16)})`);
    if (b[0] === 0xff && b[1] === 0xff) throw new Error(`${name}: encrypted, which this script does not read`);
    return clean(b.toString("utf8")).replace(/\r\n?/g, "\n");
  }

  bif(index) {
    let bif = this.open.get(index);
    if (bif) return bif;
    const name = this.bifs[index];
    if (name === undefined) throw new Error(`chitin.key: no BIFF ${index}`);
    const fd = openSync(findPath(this.root, name), "r");
    const header = Buffer.alloc(20);
    readSync(fd, header, 0, 20, 0);
    if (!hasSignature(header, "BIFFV1  ", 20)) {
      closeSync(fd);
      throw new Error(`${name}: not BIFF V1 (compressed BIFFs are not read)`);
    }
    const [nfiles, offset] = [header.readUInt32LE(8), header.readUInt32LE(16)];
    const table = Buffer.alloc(nfiles * 16);
    readSync(fd, table, 0, table.length, offset);
    const files = new Map();
    for (let i = 0; i < nfiles; i++) {
      files.set(table.readUInt32LE(i * 16) & 0x3fff, { offset: table.readUInt32LE(i * 16 + 4), size: table.readUInt32LE(i * 16 + 8) });
    }
    bif = { fd, files };
    this.open.set(index, bif);
    return bif;
  }

  close() {
    for (const { fd } of this.open.values()) closeSync(fd);
    this.open.clear();
  }
}

/** A 2DA file: one object per row, with `name` and a field per column. */
function parse2da(text, where) {
  const lines = text.split("\n");
  if (!/^2DA\s+V1\.0\s*$/.test(lines[0] ?? "")) throw new Error(`${where}: not 2DA V1.0`);
  const fallback = (lines[1] ?? "").trim();
  const columns = (lines[2] ?? "").trim().split(/\s+/);
  return lines
    .slice(3)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, ...values] = line.split(/\s+/);
      return { name, ...Object.fromEntries(columns.map((column, i) => [column, values[i] ?? fallback])) };
    });
}

/** An IDS file: [value, symbol] pairs, in file order. */
function parseIds(text) {
  return text.split("\n").flatMap((line) => {
    const m = /^\s*(0x[0-9a-f]+|\d+)\s+(\S+)/i.exec(line);
    return m ? [[Number(m[1]), m[2]]] : [];
  });
}

/** CFBundleShortVersionString from the install's macOS app bundle. */
function appVersion(install) {
  const app = readdirSync(install).find((file) => file.endsWith(".app"));
  const plist = app && join(install, app, "Contents", "Info.plist");
  if (!plist || !existsSync(plist)) throw new Error("no macOS app in the install; pass --game-version");
  const version = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(plist, "utf8"))?.[1];
  if (!version) throw new Error(`${plist}: no CFBundleShortVersionString; pass --game-version`);
  return version.trim();
}

/** A path under root, matching each part without regard to case, as the game does. */
function findPath(root, rel, required = true) {
  let path = root;
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    const match = existsSync(join(path, part))
      ? part
      : (readdirSafe(path).find((file) => file.toLowerCase() === part.toLowerCase()) ?? null);
    if (match === null) {
      if (required) throw new Error(`${join(root, rel)}: not found`);
      return undefined;
    }
    path = join(path, match);
  }
  return path;
}

function readdirSafe(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

// ---------- helpers ----------

function hasSignature(b, signature, minLength) {
  return b !== undefined && b.length >= minLength && b.toString("latin1", 0, 8) === signature;
}

function checkRange(b, offset, length) {
  if (offset < 0 || length < 0 || offset + length > b.length) {
    throw new Error(`offset 0x${offset.toString(16)} + ${length} is past the end (${b.length} bytes)`);
  }
}

function cstring(b, offset, length) {
  const s = b.toString("latin1", offset, offset + length);
  const nul = s.indexOf("\0");
  return nul < 0 ? s : s.slice(0, nul);
}

/** The strref if it has text, else null. */
function textRef(tlk, strref) {
  return tlk.text(strref) === undefined ? null : strref;
}

function clean(text) {
  return text.replace(/\u0000/g, "\uFFFD");
}

function titleCase(symbol) {
  return symbol
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A copy with keys sorted: numeric keys by value, others by code unit. */
function sortKeys(object) {
  const keys = Object.keys(object);
  const numeric = keys.every((key) => /^\d+$/.test(key));
  keys.sort(numeric ? (a, b) => Number(a) - Number(b) : compare);
  return Object.fromEntries(keys.map((key) => [key, object[key]]));
}

function objectLines(object) {
  const lines = Object.entries(object).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return `{\n${lines.join(",\n")}\n}\n`;
}

function arrayLines(array) {
  return `[\n${array.map((value) => `  ${JSON.stringify(value)}`).join(",\n")}\n]\n`;
}

main();
