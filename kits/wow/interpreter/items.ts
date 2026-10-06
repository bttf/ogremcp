// The items of `wow_get_state`'s inventory section (docs/architecture.md
// §10.4): each snapshot item with what the interpreter derives from the IDs
// of its link and from the adapter's `suffix_text` and `enchant_text` (§6.3).
// The adapter stores text only, as the client gives it. The color escapes are
// removed and the numbers are read out of it here, at the tool call, so a
// parsing fix applies to every stored snapshot.
import { ITEM_STATS_KEY_MAX_LENGTH, type WowState } from "./schema.js";

type Inventory = NonNullable<WowState["inventory"]>;
type SnapshotBagItem = Inventory["items"][number];
type SnapshotEquippedItem = Inventory["equipped"][number];

export type ItemStats = { [name: string]: number };

/** The random suffix of an item, such as "of the Bear". */
export interface ItemSuffix {
  id: number;
  /**
   * The suffix's tooltip lines, joined with ", ", such as
   * "+5 Intellect, +5 Strength". One string, like an enchant's text. Null when
   * the adapter has not read the lines.
   */
  text: string | null;
}

/** The enchant of an item. A temporary weapon enchant is not in the link, so it is not one (§6.3). */
export interface ItemEnchant {
  id: number;
  /** The enchant's tooltip line. Null when the adapter has not read it. */
  text: string | null;
  /** Null when the text gives no stat, such as "Crusader". */
  stats: ItemStats | null;
}

/** The snapshot fields that `buildItem` replaces with `suffix` and `enchant`. */
type LinkField = "link" | "unique_id" | "enchant_id" | "suffix_id" | "suffix_text" | "enchant_text";
type Built<T> = Omit<T, LinkField> & { suffix?: ItemSuffix; enchant?: ItemEnchant };
export type BagItem = Built<SnapshotBagItem>;
export type EquippedItem = Built<SnapshotEquippedItem>;

/**
 * The client's color escapes: `|cAARRGGBB` and `|cn<name>:` open a color, and
 * `|r` closes it. Classic Era 1.15.9 gives a suffix line with them, as
 * `|cffffffff+5 Intellect|r` (owner's check, 2026-10-06).
 */
const COLOR_ESCAPE = /\|c[0-9a-f]{8}|\|cn[^:|]*:|\|r/gi;

/** `text` without its color escapes (§10.4), trimmed. */
function plainText(text: string): string {
  return text.replace(COLOR_ESCAPE, "").trim();
}

/** A stat name: words of letters, one space apart. */
const NAME = "[A-Za-z]+(?: [A-Za-z]+)*";
/** `+N Name`, such as "+2 Stamina". */
const VALUE_FIRST = new RegExp(`^\\+(\\d{1,6}) (${NAME})$`);
/** `Name +N`, such as "Reinforced Armor +16". */
const NAME_FIRST = new RegExp(`^(${NAME}) \\+(\\d{1,6})$`);

/** Names whose stat has another key. The line of an armor kit reads "Reinforced Armor". */
const STAT_KEYS: ReadonlyMap<string, string> = new Map([["reinforced_armor", "armor"]]);

/**
 * The stat of one tooltip line without color escapes (§10.4). A line of the
 * form `+N Name` or `Name +N` gives the stat `name: N`, with the name in snake
 * case. Any other line gives null, such as "Crusader" or
 * "+1 mana every 5 sec.". Only English text is parsed: a line in another
 * language gives null, or a stat under the name it has in that language.
 */
export function statFromText(line: string): { name: string; value: number } | null {
  const valueFirst = VALUE_FIRST.exec(line);
  const nameFirst = valueFirst === null ? NAME_FIRST.exec(line) : null;
  const [value, words] = valueFirst !== null ? [valueFirst[1], valueFirst[2]] : [nameFirst?.[2], nameFirst?.[1]];
  if (value === undefined || words === undefined) return null;
  const name = words.toLowerCase().replaceAll(" ", "_");
  // A longer name is no key of an item's `stats` (schema.ts).
  if (name.length > ITEM_STATS_KEY_MAX_LENGTH) return null;
  return { name: STAT_KEYS.get(name) ?? name, value: Number(value) };
}

/**
 * `base` plus the stats of `lines`, summed by name. Null when `base` is null
 * and no line gives a stat. A Map holds the sums, because a name from game
 * text can be a key that every object has, such as `constructor`.
 */
function addStats(base: ItemStats | null, lines: readonly string[]): ItemStats | null {
  const stats = new Map(Object.entries(base ?? {}));
  for (const line of lines) {
    const stat = statFromText(line);
    if (stat !== null) stats.set(stat.name, (stats.get(stat.name) ?? 0) + stat.value);
  }
  return base === null && stats.size === 0 ? null : Object.fromEntries(stats);
}

/**
 * `item` as the agent gets it (§10.4). The color escapes are removed from the
 * suffix and enchant text first. An item whose link has a suffix ID has
 * `suffix`, and its `stats` are the base stats plus the suffix stats. An item
 * whose link has an enchant ID has `enchant`. The enchant's stats are not
 * added to `stats`. `link` and the unique ID are left out, to save space.
 * An item of an adapter before 0.6.0 has no link, so it stays as it is.
 */
export function buildItem<T extends SnapshotBagItem | SnapshotEquippedItem>(item: T): Built<T> {
  const { link: _link, unique_id: _unique, enchant_id, suffix_id, suffix_text, enchant_text, ...rest } = item;
  // A text that is empty without its escapes counts as not read.
  const suffixLines = suffix_text?.map(plainText).filter((line) => line !== "") ?? [];
  const enchantLine = (enchant_text ? plainText(enchant_text) : "") || null;
  const suffix: ItemSuffix | null = suffix_id ? { id: suffix_id, text: suffixLines.join(", ") || null } : null;
  const enchant: ItemEnchant | null = enchant_id
    ? { id: enchant_id, text: enchantLine, stats: addStats(null, enchantLine === null ? [] : [enchantLine]) }
    : null;
  return {
    ...rest,
    ...(suffix !== null && suffix.text !== null && { stats: addStats(item.stats ?? null, suffixLines) }),
    ...(suffix !== null && { suffix }),
    ...(enchant !== null && { enchant }),
  };
}
