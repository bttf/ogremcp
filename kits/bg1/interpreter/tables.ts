// The name tables in kits/bg1/data/ (docs/architecture.md §6.6.3), built by
// scripts/extract-tables.mjs; its header documents each table. They ship in
// the package next to dist/, and are read once, on the first parse.
import { readFileSync } from "node:fs";

export interface Tables {
  /** Strref -> text. */
  strings: ReadonlyMap<number, string>;
  /** Each quest's title and entries, as strrefs, in the game's order. */
  quests: readonly { title: number; entries: readonly number[] }[];
  /** Resref -> identified and unidentified name strrefs. */
  items: ReadonlyMap<string, { name: number | null; unidentified: number | null }>;
  /** Resref -> name strref. */
  spells: ReadonlyMap<string, number>;
  /** Death variable -> name strref, for the characters who can join the party. */
  joinable: ReadonlyMap<string, number>;
  /** Resref -> name. */
  areas: ReadonlyMap<string, string>;
  /** Option -> ID -> name. */
  options: { [option in Option]: ReadonlyMap<number, string> };
}

export type Option = "alignment" | "class" | "gender" | "kit" | "proficiency" | "race";

let tables: Tables | undefined;

/** The tables, read on the first call. */
export function loadTables(): Tables {
  tables ??= readTables();
  return tables;
}

function readTables(): Tables {
  // This file is in interpreter/ (tests) or dist/ (built), both next to data/.
  const read = (name: string): unknown => JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), "utf8"));
  const byNumber = <T>(object: unknown) => new Map(Object.entries(object as { [key: string]: T }).map(([key, value]) => [Number(key), value]));
  const byName = <T>(object: unknown) => new Map(Object.entries(object as { [key: string]: T }));
  const options = read("options.json") as { [option in Option]: { [id: string]: string } };
  return {
    strings: byNumber<string>(read("strings.json")),
    quests: read("quests.json") as Tables["quests"],
    items: byName(read("items.json")),
    spells: byName(read("spells.json")),
    joinable: byName(read("joinable.json")),
    areas: byName(read("areas.json")),
    options: {
      alignment: byNumber(options.alignment),
      class: byNumber(options.class),
      gender: byNumber(options.gender),
      kit: byNumber(options.kit),
      proficiency: byNumber(options.proficiency),
      race: byNumber(options.race),
    },
  };
}
