// The sections of `wow_get_state`'s result (docs/architecture.md §10.4): each
// snapshot section as the agent gets it. The fields are the snapshot's, plus
// forms that are easier to use than the raw values: money in gold, silver,
// and copper, positions as percentages of the zone map with the part of the
// map in words, facing as a compass direction, item quality as a word, a gear
// comparison, and the skills a trainer can raise.
//
// Adapted from the result builders of bttf/wow-guide@df80260:
// cloud/src/mcpTools.ts (qualityWord, money, percent, compass, regionWord,
// directionBetween, buildPlayerState, buildLocation, buildInventory,
// buildPath) and cloud/src/mcpSkills.ts (buildSkills), without the detail
// levels (§10.5) and the text rendering: the text block is the result's JSON
// (§10.5). Without the detail levels, the quests section is the snapshot's as
// it is. Fields are snake_case, like the snapshot's.
import { type GearComparison, summariseGear } from "./gear.js";
import { SKILL_CATEGORIES, type WowState } from "./schema.js";

/** The sections, in the order a result lists them (§10.4). */
export const SECTIONS = ["character", "location", "quests", "inventory", "skills", "recent_path"] as const;
export type Section = (typeof SECTIONS)[number];

type Character = NonNullable<WowState["character"]>;
type Location = NonNullable<WowState["location"]>;
type Inventory = NonNullable<WowState["inventory"]>;
type Skills = NonNullable<WowState["skills"]>;
type Skill = Skills["lines"][number];
type RecentPath = NonNullable<WowState["recent_path"]>;

/**
 * The `sections` of `state`, each built for the agent, keyed by section. A
 * section the adapter left out is null. `flavor` is the snapshot's.
 */
export function buildSections(state: WowState, flavor: string, sections: readonly Section[]): BuiltSections {
  const built: { [key: string]: unknown } = {};
  for (const section of sections) built[section] = BUILDERS[section](state, flavor);
  return built as BuiltSections;
}

const BUILDERS = {
  character: ({ character }) => character && buildCharacter(character),
  location: ({ location }) => location && buildLocation(location),
  quests: ({ quests }) => quests,
  inventory: ({ inventory, character }) => inventory && buildInventory(inventory, character?.level ?? null),
  skills: ({ skills }, flavor) => skills && buildSkills(skills, flavor),
  recent_path: ({ recent_path }) => recent_path && buildRecentPath(recent_path),
} satisfies { [S in Section]: (state: WowState, flavor: string) => unknown };

/** What `buildSections` returns: each requested section, as its builder makes it. */
export type BuiltSections = { [S in Section]?: ReturnType<(typeof BUILDERS)[S]> };

function buildCharacter({ copper, ...character }: Character) {
  const { xp_percent } = character;
  return { ...character, xp_percent: xp_percent === null ? null : Math.round(xp_percent * 10) / 10, money: money(copper) };
}

/** Copper, and its `1g 23s 45c` form: 100 copper is 1 silver, 100 silver is 1 gold. */
function money(copper: number | null): { copper: number; text: string } | null {
  if (copper === null) return null;
  return { copper, text: `${Math.floor(copper / 10000)}g ${Math.floor(copper / 100) % 100}s ${copper % 100}c` };
}

/**
 * `x_percent` runs from 0 at the west edge of the zone map to 100 at the east
 * edge, and `y_percent` from 0 at the north edge to 100 at the south edge.
 */
function buildLocation({ x, y, facing, ...location }: Location) {
  const x_percent = percent(x);
  const y_percent = percent(y);
  return { ...location, x_percent, y_percent, region: regionWord(x_percent, y_percent), facing: compass(facing) };
}

/** A 0..1 map position as a percentage, to one decimal. */
function percent(fraction: number | null): number | null {
  return fraction === null ? null : Math.round(fraction * 1000) / 10;
}

const COMPASS = ["north", "northwest", "west", "southwest", "south", "southeast", "east", "northeast"] as const;
type CompassWord = (typeof COMPASS)[number];

/** `GetPlayerFacing()` is in radians, counter-clockwise from north. */
function compass(facing: number | null): CompassWord | null {
  if (facing === null) return null;
  return COMPASS[Math.round(facing / (Math.PI / 4)) % 8] ?? null;
}

/**
 * The part of the zone map, as one of nine phrases. Each axis is cut in
 * thirds. `xPercent` runs west to east and `yPercent` north to south.
 */
function regionWord(xPercent: number | null, yPercent: number | null): string | null {
  if (xPercent === null || yPercent === null) return null;
  const third = (value: number, low: string, high: string) => (value < 100 / 3 ? low : value > 200 / 3 ? high : "");
  const word = third(yPercent, "north", "south") + third(xPercent, "west", "east");
  return word === "" ? "the middle of the zone" : `the ${word} part of the zone`;
}

/** A zone map is 3 wide and 2 high, so one percent of x is 1.5 times as long as one percent of y. */
const MAP_ASPECT = 1.5;
/**
 * Two positions closer than this have no direction between them. The unit is
 * one percent of the map height. The x difference is scaled by `MAP_ASPECT`
 * first, so both axes are in this unit and the distance is the straight line.
 */
const MIN_MOVE = 2;

interface Point {
  x: number | null;
  y: number | null;
}

/** Compass direction of travel between two positions on one map, given as percentages. */
function directionBetween(from: Point, to: Point): CompassWord | null {
  if (from.x === null || from.y === null || to.x === null || to.y === null) return null;
  const east = (to.x - from.x) * MAP_ASPECT;
  const north = from.y - to.y;
  if (Math.hypot(east, north) < MIN_MOVE) return null;
  // Counter-clockwise from north, like `compass`.
  const angle = (Math.atan2(-east, north) + 2 * Math.PI) % (2 * Math.PI);
  return COMPASS[Math.round(angle / (Math.PI / 4)) % 8] ?? null;
}

/** Item quality as a word, by the client's quality number. */
const QUALITY_WORDS = ["poor", "common", "uncommon", "rare", "epic", "legendary", "artifact", "heirloom"] as const;

function withQualityWord<T extends { quality: number | null }>(item: T) {
  return { ...item, quality: item.quality === null ? null : (QUALITY_WORDS[item.quality] ?? null) };
}

/** Most better bag items listed for one slot. `better_total` counts them all. */
const MAX_BETTER_PER_SLOT = 3;

/**
 * The caveat of a slot where a bag item is better or fills the empty slot: the
 * comparison cannot tell whether the character can use the item.
 */
export const GEAR_CAVEAT =
  "Class and weapon or armor proficiency are not in the data and are not checked: this character may not be able to use the bag item.";

/**
 * The items with their quality as a word, and `gear`: per equipment slot, the
 * equipped item and whether a bag item for the slot is better (gear.ts).
 * `gear_incomplete` is true when the adapter did not read the details of every
 * item (`items_pending` is not 0), so a bag item that fits a slot, or a better
 * one, may be missing: a slot then reads `incomplete` in place of
 * `none_better` or `no_candidates`.
 */
function buildInventory(inventory: Inventory, level: number | null) {
  const gearIncomplete = inventory.items_pending !== 0;
  const honest = (comparison: GearComparison): GearComparison =>
    gearIncomplete && (comparison === "none_better" || comparison === "no_candidates") ? "incomplete" : comparison;
  return {
    items_pending: inventory.items_pending,
    gear_incomplete: gearIncomplete,
    equipped: inventory.equipped.map(withQualityWord),
    items: inventory.items.map(withQualityWord),
    gear: summariseGear(inventory, level).map((entry) => ({
      slot: entry.slot,
      equipped: entry.equipped && { item_id: entry.equipped.item_id, name: entry.equipped.name },
      comparison: honest(entry.comparison),
      ...((entry.comparison === "better_in_bags" || entry.comparison === "fills_empty_slot") && { caveat: GEAR_CAVEAT }),
      measure: entry.measure,
      candidates: entry.candidates,
      not_compared: entry.notCompared,
      above_level: entry.aboveLevel,
      better_total: entry.better.length,
      better: entry.better.slice(0, MAX_BETTER_PER_SLOT).map(({ item, measure, value, equippedValue }) => ({
        item_id: item.item_id,
        name: item.name,
        measure,
        value,
        equipped_value: equippedValue,
      })),
    })),
  };
}

/** Categories whose maximum a trainer raises. */
const TRAINED: ReadonlySet<Skill["category"]> = new Set(["profession", "secondary"]);

/**
 * The highest maximum rank a trainer gives, per flavor, for professions and
 * secondary skills. Classic Era's is 300 (Artisan). Another flavor's is not
 * known, so there a trainer visit only may be due.
 */
const TOP_MAX_RANK: { [flavor: string]: number } = { classic_era: 300 };

/**
 * Riding skills can sit under the secondary skills. A trainer does not raise
 * them rank by rank, so they are never due. Matched by their English names.
 */
const RIDING = /riding|piloting|horsemanship/i;

/**
 * The lines grouped by category (primary professions first), in the Skills
 * tab's order within a group. `at_max` is true when `rank` has reached
 * `max_rank`. `training_due` names the professions and secondary skills at
 * their maximum rank that a trainer can still raise.
 */
function buildSkills(skills: Skills, flavor: string) {
  const top = TOP_MAX_RANK[flavor] ?? null;
  const lines = SKILL_CATEGORIES.flatMap((category) => skills.lines.filter((skill) => skill.category === category).map(skillLine));
  const trainingDue = lines.filter((line) => due(line, top)).map((line) => line.name);
  return { partial: skills.partial, lines, training_due: trainingDue };
}

function skillLine(skill: Skill) {
  const { rank, max_rank } = skill;
  // A maximum of 0 or less is no real maximum, so it says nothing about training.
  return { ...skill, at_max: rank === null || max_rank === null || max_rank <= 0 ? null : rank >= max_rank };
}

/** A trained skill at its maximum that a trainer can still raise. */
function due(line: ReturnType<typeof skillLine>, top: number | null): boolean {
  if (line.at_max !== true || !TRAINED.has(line.category) || RIDING.test(line.name)) return false;
  return top === null || (line.max_rank ?? 0) < top;
}

/**
 * Places, newest first, with `captured_at` as an ISO 8601 instant, or null
 * when it is out of a Date's range. `moved` is the compass direction of
 * travel from the place before, when both are on one map with a position.
 */
function buildRecentPath(path: RecentPath) {
  return path
    .map(({ captured_at, x, y, ...place }, i) => {
      const x_percent = percent(x);
      const y_percent = percent(y);
      const before = path[i - 1];
      const moved =
        before !== undefined && before.map_id !== null && before.map_id === place.map_id
          ? directionBetween({ x: percent(before.x), y: percent(before.y) }, { x: x_percent, y: y_percent })
          : null;
      return {
        captured_at: isoTime(captured_at),
        ...place,
        x_percent,
        y_percent,
        region: regionWord(x_percent, y_percent),
        moved,
      };
    })
    .reverse();
}

/** Unix seconds as an ISO 8601 instant, or null out of a Date's range, where `toISOString` throws. */
function isoTime(seconds: number): string | null {
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
