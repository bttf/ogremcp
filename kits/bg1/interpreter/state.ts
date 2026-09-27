// The snapshot state of a BG:EE save (docs/architecture.md §6.6.4): the codes
// gam.ts reads, looked up in the name tables (§6.6.3). A code missing from
// the tables keeps the code and has no text. The state holds only strings,
// finite numbers, booleans, null, arrays, and plain objects, so it is
// JSON-serializable (§11 stores it as jsonb).
import type { Cre, Gam, Item, JournalEntry, Npc } from "./gam.js";
import type { Option, Tables } from "./tables.js";

/** The sections, in the order a result lists them (§10.6). */
export const SECTIONS = ["game", "party", "inventory", "quests", "former_party"] as const;
export type Section = (typeof SECTIONS)[number];

export interface Bg1State {
  game: GameSection;
  party: PartyMember[];
  inventory: MemberInventory[];
  quests: QuestsSection;
  former_party: FormerMember[];
}

/** An area: its resref, and its name, or null when the tables lack it. */
export interface Area {
  code: string;
  name: string | null;
}

/** A character option (class, kit, race, alignment, gender): its IDS value, and its name, or null when the tables lack it. */
export interface Named {
  id: number;
  name: string | null;
}

export interface GameSection {
  /** The CHAPTER global, or null when the save has none. */
  chapter: number | null;
  /** The game day, counted from 0, as the game counts it. */
  day: number;
  hour: number;
  gold: number;
  reputation: number;
  area: Area | null;
}

export interface PartyMember {
  /** Null, with `strref`, when the tables lack the name. */
  name: string | null;
  strref?: number;
  protagonist: boolean;
  class: Named;
  /** Null for a character without a kit. */
  kit: Named | null;
  race: Named;
  alignment: Named;
  gender: Named;
  /** One per class of a multi-class or dual-class character, in the order of the class's name. */
  levels: { class: string | null; level: number }[];
  xp: number;
  hp: number;
  max_hp: number;
  abilities: Cre["abilities"];
  // The save holds the base THAC0, saving throws, thief skills, and weapon
  // proficiencies: the game adds the items', effects', and ability scores'
  // bonuses as it plays. It holds no armor class but the base 10, so the
  // state leaves it out.
  base_thac0: number;
  base_saving_throws: { death: number; wands: number; polymorph: number; breath: number; spells: number };
  /** Null for a class without thief skills. */
  base_thief_skills: Cre["thief"] | null;
  /** The weapon proficiencies with more than 0 pips, in proficiency ID order. Null name, with `id`, when the tables lack it. */
  base_proficiencies: { name: string | null; id?: number; pips: number }[];
  status: { dead: boolean; flags: string[] };
  /** The memorized spells, one line per spell and level, with how many of them are memorized and ready. */
  spells: { code: string; name: string | null; type: SpellType | null; level: number; memorized: number; ready: number }[];
}

export type SpellType = "priest" | "wizard" | "innate";

/**
 * An item. An unidentified one shows only its unidentified name, as the game
 * does: no code, and no name when the tables lack the unidentified one.
 * `charges` is the quantity of a stack, or the charges per ability, without
 * trailing zeros.
 */
export interface ItemView {
  code?: string;
  name: string | null;
  identified: boolean;
  charges: number[];
}

export interface MemberInventory {
  name: string | null;
  equipped: (ItemView & { slot: string })[];
  backpack: ItemView[];
}

export interface JournalText {
  /** Null, with `strref`, when the tables lack the text. */
  text: string | null;
  strref?: number;
  chapter: number;
  /** The game day, counted from 0, like `game.day`. */
  day: number;
}

export interface Quest {
  /** Null, with `strref`, when the tables lack the title. */
  title: string | null;
  strref?: number;
  /** Oldest first. */
  entries: JournalText[];
}

export interface QuestsSection {
  /** Most recently updated first. */
  open: Quest[];
  completed: Quest[];
  /** Entries that belong to no quest: letters, notes, events. Oldest first. */
  other: JournalText[];
}

export interface FormerMember {
  name: string | null;
  strref?: number;
  area: Area | null;
}

/** Game time units (GAM 0x08). */
const PER_HOUR = 300;
const PER_DAY = 24 * PER_HOUR;
/** Journal times count 15 ticks per game time unit. */
const JOURNAL_TICKS = 15;

/** CRE 0x10: the creature has been in the party. */
const BEEN_IN_PARTY = 1 << 15;
/** STATE.IDS bits 6 to 11: the death states. */
const DEAD_STATES = 0x0fc0;
const DEAD = 11;
/** STATE.IDS, by bit (IESDP). Bit 19 is DISEASED before the Enhanced Editions. */
const STATE_FLAGS = [
  "sleeping", "berserk", "panic", "stunned", "invisible", "helpless", "frozen_death", "stone_death",
  "exploding_death", "flame_death", "acid_death", "dead", "silenced", "charmed", "poisoned", "hasted",
  "slowed", "infravision", "blind", "deactivated", "feebleminded", "nondetection", "improved_invisibility", "bless",
  "chant", "draw_upon_holy_might", "luck", "aid", "chant_bad", "blur", "mirror_image", "confused",
] as const;

/** CLASS.IDS values of the multi-classes, and how many classes each has. Every other class has one. */
const CLASS_COUNT = new Map([[7, 2], [8, 2], [9, 2], [10, 3], [13, 2], [14, 2], [15, 2], [16, 2], [17, 3], [18, 2]]);
/** CLASS.IDS values of the classes with thief skills: the thieves, bards, rangers, and monks. */
const THIEF_SKILL_CLASSES = new Set([4, 5, 9, 10, 12, 13, 15, 18, 20]);
/** KIT.IDS values that mean no kit: none, and TRUECLASS. */
const NO_KIT = new Set([0, 0x4000]);

const SPELL_TYPES: readonly SpellType[] = ["priest", "wizard", "innate"];

/** The CRE item slots before the backpack, by index (IESDP, CRE V1.0). The magic weapon slot follows the backpack. */
const EQUIPMENT_SLOTS = [
  "helmet", "armor", "shield", "gloves", "left_ring", "right_ring", "amulet", "belt", "boots",
  "weapon_1", "weapon_2", "weapon_3", "weapon_4", "quiver_1", "quiver_2", "quiver_3", "quiver_4", "cloak",
  "quick_item_1", "quick_item_2", "quick_item_3",
];
const BACKPACK_SLOTS = 16;
const MAGIC_WEAPON_SLOT = EQUIPMENT_SLOTS.length + BACKPACK_SLOTS;

/** The state of `gam`, with names from `tables`. */
export function buildState(gam: Gam, tables: Tables): Bg1State {
  const members = gam.party.flatMap((npc, record) => (npc.cre ? [{ npc, cre: npc.cre, protagonist: record === 0 }] : []));
  // Party order is the portrait order (GAM NPC 0x02); the records are in join order.
  members.sort((a, b) => a.npc.partyOrder - b.npc.partyOrder);
  const lookup = new Lookup(tables);
  return {
    game: {
      chapter: gam.chapter,
      day: Math.floor(gam.gameTime / PER_DAY),
      hour: Math.floor((gam.gameTime % PER_DAY) / PER_HOUR),
      gold: gam.gold,
      reputation: gam.reputation / 10,
      area: lookup.area(gam.party[gam.activeMember]?.area || gam.currentArea),
    },
    party: members.map(({ npc, cre, protagonist }) => partyMember(npc, cre, protagonist, lookup)),
    inventory: members.map(({ npc, cre }) => inventory(npc, cre, lookup)),
    quests: quests(gam.journal, lookup),
    former_party: gam.others.flatMap((npc) => {
      const strref = npc.cre && npc.cre.flags & BEEN_IN_PARTY ? tables.joinable.get(npc.cre.deathVariable) : undefined;
      return strref === undefined ? [] : [{ ...lookup.name(strref, "name"), area: lookup.area(npc.area) }];
    }),
  };
}

/** Lookups in the tables, each keeping the code when the tables lack it. */
class Lookup {
  constructor(readonly tables: Tables) {}

  /** `{ [key]: text }`, or `{ [key]: null, strref }` when the tables lack the text. */
  name<K extends string>(strref: number, key: K): { [k in K]: string | null } & { strref?: number } {
    const text = this.tables.strings.get(strref);
    return (text === undefined ? { [key]: null, strref } : { [key]: text }) as { [k in K]: string | null } & { strref?: number };
  }

  area(code: string): Area | null {
    return code === "" ? null : { code, name: this.tables.areas.get(code) ?? null };
  }

  option(option: Option, id: number): Named {
    return { id, name: this.tables.options[option].get(id) ?? null };
  }

  item(item: Item): ItemView {
    const names = this.tables.items.get(item.code);
    const text = (strref: number | null | undefined) => (strref == null ? undefined : this.tables.strings.get(strref));
    const charges = item.charges.slice(0, item.charges.findLastIndex((n) => n !== 0) + 1);
    if (names === undefined) return { code: item.code, name: null, identified: item.identified, charges };
    if (!item.identified) return { name: text(names.unidentified) ?? null, identified: false, charges };
    return { code: item.code, name: text(names.name) ?? text(names.unidentified) ?? null, identified: true, charges };
  }

  /** `{ name }`, or `{ name: null, id }` when the tables lack the proficiency. */
  proficiency(id: number): { name: string | null; id?: number } {
    const name = this.tables.options.proficiency.get(id);
    return name === undefined ? { name: null, id } : { name };
  }

  spell(code: string): string | null {
    const strref = this.tables.spells.get(code);
    return strref === undefined ? null : (this.tables.strings.get(strref) ?? null);
  }
}

/** The protagonist's name is the GAM's name field; a joinable character's is the CRE's long name. */
function memberName(npc: Npc, cre: Cre, lookup: Lookup): { name: string | null; strref?: number } {
  return npc.name !== "" ? { name: npc.name } : lookup.name(cre.longName, "name");
}

function partyMember(npc: Npc, cre: Cre, protagonist: boolean, lookup: Lookup): PartyMember {
  const className = lookup.option("class", cre.class);
  const classCount = CLASS_COUNT.get(cre.class) ?? 1;
  const classNames = className.name?.split(" / ");
  const [death = 0, wands = 0, polymorph = 0, breath = 0, spells = 0] = cre.saves;
  return {
    ...memberName(npc, cre, lookup),
    protagonist,
    class: className,
    kit: NO_KIT.has(cre.kit) ? null : lookup.option("kit", cre.kit),
    race: lookup.option("race", cre.race),
    alignment: lookup.option("alignment", cre.alignment),
    gender: lookup.option("gender", cre.gender),
    levels: cre.levels.slice(0, classCount).map((level, i) => ({
      class: classNames?.length === classCount ? (classNames[i] ?? null) : null,
      level,
    })),
    xp: cre.xp,
    hp: cre.hp,
    max_hp: cre.maxHp,
    abilities: cre.abilities,
    base_thac0: cre.thac0,
    base_saving_throws: { death, wands, polymorph, breath, spells },
    base_thief_skills: THIEF_SKILL_CLASSES.has(cre.class) ? cre.thief : null,
    base_proficiencies: [...cre.proficiencies]
      .filter(([, pips]) => pips > 0)
      .sort(([a], [b]) => a - b)
      .map(([id, pips]) => ({ ...lookup.proficiency(id), pips })),
    status: {
      dead: (cre.state & DEAD_STATES) !== 0,
      flags: STATE_FLAGS.filter((_, bit) => bit !== DEAD && (cre.state >>> bit) & 1),
    },
    spells: memorizedSpells(cre, lookup),
  };
}

function memorizedSpells(cre: Cre, lookup: Lookup): PartyMember["spells"] {
  const lines = new Map<string, PartyMember["spells"][number]>();
  for (const spell of cre.memorized) {
    const key = `${spell.type}:${spell.level}:${spell.code}`;
    let line = lines.get(key);
    if (line === undefined) {
      line = { code: spell.code, name: lookup.spell(spell.code), type: SPELL_TYPES[spell.type] ?? null, level: spell.level, memorized: 0, ready: 0 };
      lines.set(key, line);
    }
    line.memorized++;
    if (spell.ready) line.ready++;
  }
  return [...lines.values()];
}

function inventory(npc: Npc, cre: Cre, lookup: Lookup): MemberInventory {
  const equipped: MemberInventory["equipped"] = [];
  const add = (slot: string, item: Item | null | undefined) => {
    if (item) equipped.push({ slot, ...lookup.item(item) });
  };
  EQUIPMENT_SLOTS.forEach((slot, i) => add(slot, cre.slots[i]));
  add("magic_weapon", cre.slots[MAGIC_WEAPON_SLOT]);
  const backpack = cre.slots
    .slice(EQUIPMENT_SLOTS.length, MAGIC_WEAPON_SLOT)
    .flatMap((item) => (item ? [lookup.item(item)] : []));
  return { name: memberName(npc, cre, lookup).name, equipped, backpack };
}

/**
 * The journal grouped as the game's Quests tab groups it (UI.MENU
 * updateJournalEntry and initQuests, v2.7.3). An entry belongs to a quest when
 * the quest list names its strref and its section is a quest or a completed
 * quest; when several quests name it, to the last of them in the list. Notes
 * and journal info entries belong to no quest. A quest is complete when any
 * of its entries is (UTIL.LUA updateQuestState).
 *
 * Each strref shows once, as in the game (UI.MENU updateJournalEntry): a
 * repeated quest entry keeps its place and takes the chapter and day of its
 * last copy, and a repeated entry in no quest keeps its first copy. The game lists a repeated note
 * (section 0) each time; here it shows once too.
 */
function quests(journal: readonly JournalEntry[], lookup: Lookup): QuestsSection {
  const questOf = new Map<number, number>();
  lookup.tables.quests.forEach((quest, index) => {
    for (const entry of quest.entries) questOf.set(entry, index);
  });
  const found = new Map<number, { quest: Quest; complete: boolean; latest: number }>();
  const questEntries = new Map<number, JournalText>();
  const other: JournalText[] = [];
  const otherStrrefs = new Set<number>();
  for (const entry of journal) {
    const chapter = entry.chapter;
    const day = Math.floor(entry.time / JOURNAL_TICKS / PER_DAY);
    const index = questOf.get(entry.strref);
    const isQuestEntry = (entry.section & 0b011) !== 0 && (entry.section & 0b100) === 0;
    if (index === undefined || !isQuestEntry) {
      if (!otherStrrefs.has(entry.strref)) other.push({ ...lookup.name(entry.strref, "text"), chapter, day });
      otherStrrefs.add(entry.strref);
      continue;
    }
    let quest = found.get(index);
    if (quest === undefined) {
      const title = lookup.tables.quests[index]?.title ?? 0;
      quest = { quest: { ...lookup.name(title, "title"), entries: [] }, complete: false, latest: 0 };
      found.set(index, quest);
    }
    const seen = questEntries.get(entry.strref);
    if (seen === undefined) {
      const text: JournalText = { ...lookup.name(entry.strref, "text"), chapter, day };
      questEntries.set(entry.strref, text);
      quest.quest.entries.push(text);
    } else {
      Object.assign(seen, { chapter, day });
    }
    quest.complete ||= (entry.section & 0b010) !== 0;
    quest.latest = Math.max(quest.latest, entry.time);
  }
  const byLatest = [...found.values()].sort((a, b) => b.latest - a.latest);
  return {
    open: byLatest.filter((q) => !q.complete).map((q) => q.quest),
    completed: byLatest.filter((q) => q.complete).map((q) => q.quest),
    other,
  };
}
