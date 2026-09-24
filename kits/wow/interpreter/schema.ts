// Schemas of OpenGamerMCPDB, the table the adapter writes
// (docs/architecture.md §6.3, kits/wow/adapter/Storage.lua).
//
// The sections are adapted from bttf/wow-guide@df80260:shared/src/snapshot.ts
// (clientSchema to skillsSchema). `char` is now `character`, `loc` is
// `location`, and `bags` is `inventory`. Fields are snake_case, as the adapter
// writes them. The prototype's `state` section is split: `in_combat`,
// `resting`, `dead`, and `ghost` are in `character`, and `hearth` is in
// `location`. `quests` is `{ entries, partial }`, like `skills`. Levels are
// the client's raw values, with no cap, because the cap differs by flavor.
// The screenshot schema is dropped (D3).
//
// Lua has no null: a nil field is an absent key. Every field the client can
// report as nil is `nilable`, which reads an absent key as null. zod drops the
// keys a schema does not name, so a field a newer adapter adds is ignored.
// The parsed state holds only strings, finite numbers, booleans, null, arrays,
// and plain objects, so it is JSON-serializable (§11 stores it as jsonb).

import { z } from "zod";

/** Reads an absent key, or a null in a JSON re-encoding, as null. */
function nilable<T extends z.ZodType>(schema: T) {
  return schema.nullish().default(null);
}

/**
 * A Lua list. Lua has one table type for lists and objects, and the reader
 * (lua.ts) reads an empty table as an empty object. Read that as an empty list.
 */
function list<T extends z.ZodType>(item: T) {
  return z.preprocess(
    (value) =>
      value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0
        ? []
        : value,
    z.array(item),
  );
}

/**
 * Raw facts about the game client (§6.3). The interpreter maps them to a
 * flavor and rules (detect.ts, §6.3.1); the adapter never decides the flavor.
 */
export const clientSchema = z.object({
  /** `WOW_PROJECT_ID`. */
  project_id: nilable(z.number().int().nonnegative()),
  /** `C_Seasons.GetActiveSeason()`. Nil on a realm without a season. */
  season_id: nilable(z.number().int().nonnegative()),
  /** First return of `GetBuildInfo()`, e.g. "1.15.9". */
  version: nilable(z.string().min(1)),
  /** Second return of `GetBuildInfo()`. The client returns a string of digits. */
  build: nilable(z.string().min(1)),
  /** Fourth return of `GetBuildInfo()`, e.g. 11509. */
  interface: nilable(z.number().int().positive()),
});

/**
 * The character the state belongs to (§6.3). The GUID is the character key;
 * `name` and `realm` are for display and tool arguments. The adapter writes
 * no character rather than one without a name or realm.
 */
export const characterKeySchema = z.object({
  /** `UnitGUID("player")`, e.g. "Player-4395-0A1B2C3D". */
  guid: nilable(z.string().min(1)),
  name: z.string().min(1),
  realm: z.string().min(1),
});

/**
 * Only `name` and `realm` are required. They identify the character, and the
 * adapter drops the whole section rather than write a character without them.
 * Every other field is read from an API that may return nil or a secret.
 */
export const characterSchema = z.object({
  name: z.string().min(1),
  realm: z.string().min(1),
  /** Localised class name, first return of `UnitClass("player")`. */
  class: nilable(z.string().min(1)),
  /** Localised race name, first return of `UnitRace("player")`. */
  race: nilable(z.string().min(1)),
  /** Faction token from `UnitFactionGroup("player")`: Alliance, Horde, or Neutral. */
  faction: nilable(z.string().min(1)),
  /** `UnitLevel("player")`, uncapped. */
  level: nilable(z.number().int().min(1)),
  /** XP into the current level, `UnitXP("player")`. */
  xp: nilable(z.number().int().nonnegative()),
  /** XP needed for the current level, `UnitXPMax("player")`. */
  xp_max: nilable(z.number().int().nonnegative()),
  /** `xp / xp_max * 100`. Null when either is unreadable or `xp_max` is 0. */
  xp_percent: nilable(z.number().min(0).max(100)),
  /** Rested XP pool, `GetXPExhaustion()`. The API returns nil when not rested. */
  rested_xp: nilable(z.number().nonnegative()),
  /** Money in copper, `GetMoney()`. 10000 copper is one gold. */
  copper: nilable(z.number().int().nonnegative()),
  /** `UnitAffectingCombat("player")`. */
  in_combat: nilable(z.boolean()),
  /** `IsResting()`: in an inn or city, accruing rested XP. */
  resting: nilable(z.boolean()),
  /** `UnitIsDead("player")`. */
  dead: nilable(z.boolean()),
  /** `UnitIsGhost("player")`. */
  ghost: nilable(z.boolean()),
});

export const locationSchema = z.object({
  /** UiMapID. `C_Map.GetBestMapForUnit("player")` returns nil in some places. */
  map_id: nilable(z.number().int().nonnegative()),
  /**
   * `GetRealZoneText()`. It returns an empty string until the zone resolves
   * after a loading screen, so an empty string is a real value.
   */
  zone: nilable(z.string()),
  /** `GetSubZoneText()`. An empty string when there is no subzone. */
  subzone: nilable(z.string()),
  /**
   * Normalised 0..1 player position. `C_Map.GetPlayerMapPosition` returns nil
   * inside instances and in a few other no-position cases.
   */
  x: nilable(z.number().min(0).max(1)),
  y: nilable(z.number().min(0).max(1)),
  /** Radians, counter-clockwise from north, `GetPlayerFacing()`. Nil in instances. */
  facing: nilable(z.number().min(0).max(2 * Math.PI)),
  /** First return of `IsInInstance()`. Explains a null position. */
  in_instance: nilable(z.boolean()),
  /** Hearthstone bind location, `GetBindLocation()`. */
  hearth: nilable(z.string()),
});

/** One entry of `C_QuestLog.GetQuestObjectives(questID)`. */
export const questObjectiveSchema = z.object({
  /** Objective line as the quest log shows it, e.g. "Kobold Vermin slain: 3/10". */
  text: nilable(z.string()),
  /** Objective type, e.g. "monster", "item", "event". */
  type: nilable(z.string()),
  finished: nilable(z.boolean()),
  num_fulfilled: nilable(z.number().int().nonnegative()),
  num_required: nilable(z.number().int().nonnegative()),
});

export const questSchema = z.object({
  /** Quest ID. The adapter skips log rows without one, so it is required. */
  id: z.number().int().positive(),
  title: nilable(z.string()),
  /** The quest's level as the client reports it, uncapped. */
  level: nilable(z.number().int()),
  /**
   * Quest description, first return of `GetQuestLogQuestText`. Null until the
   * adapter has fetched it: fetches are skipped while the quest log is open.
   */
  description: nilable(z.string()),
  /** Objectives summary, second return of `GetQuestLogQuestText`. */
  objectives_text: nilable(z.string()),
  /**
   * Objectives with progress. An empty list means the quest has none; null
   * means the API returned nothing readable.
   */
  objectives: nilable(list(questObjectiveSchema)),
  /**
   * Every objective is done. `C_QuestLog.IsComplete(questID)` in WoW Forever,
   * `IsQuestComplete(questID)` in Classic Era.
   */
  complete: nilable(z.boolean()),
});

export const questsSchema = z.object({
  /** Quest log in log order, headers excluded. */
  entries: list(questSchema),
  /**
   * True when the log was not fully read: a header the player collapsed hides
   * its quests from the API, and the adapter never expands a header.
   */
  partial: z.boolean(),
});

/**
 * Most keys of one item's `stats`: 24 from the stats API, plus `dps`,
 * `min_damage`, `max_damage`, and `speed` from the tooltip
 * (kits/wow/adapter/Items.lua). And the longest key.
 */
export const ITEM_STATS_MAX_KEYS = 28;
export const ITEM_STATS_KEY_MAX_LENGTH = 40;
/** Largest absolute value of one stat. */
export const ITEM_STAT_MAX = 1_000_000;
/** Longest `equip_loc`, `type`, and `sub_type`. */
export const ITEM_TEXT_MAX_LENGTH = 60;

/**
 * Stats of one item, numbers only. The adapter normalises the client's keys:
 * `armor`, `dps`, `min_damage`, `max_damage`, `speed`, `strength`,
 * `agility`, `stamina`, `intellect`, `spirit`, the resistances
 * (`fire_resistance`), and any other `ITEM_MOD_*` key in snake case
 * (`ITEM_MOD_CRIT_RATING_SHORT` becomes `crit_rating`). A stat the adapter
 * could not read is an absent key.
 */
export const itemStatsSchema = z
  .record(
    z.string().regex(/^[a-z][a-z0-9_]*$/).max(ITEM_STATS_KEY_MAX_LENGTH),
    z.number().min(-ITEM_STAT_MAX).max(ITEM_STAT_MAX),
  )
  .refine((stats) => Object.keys(stats).length <= ITEM_STATS_MAX_KEYS, {
    message: `at most ${ITEM_STATS_MAX_KEYS} stats`,
  });

/**
 * Item details, from `GetItemInfo` and `GetItemStats`. Every field is null
 * when the client had not cached the item yet, the API is missing, or the
 * value is secret. A bag item that cannot be equipped carries `quality`,
 * `type`, `sub_type`, and `sell_price` only.
 */
const itemDetailShape = {
  /** Quality number: 0 poor, 1 common, 2 uncommon, 3 rare, 4 epic, 5 legendary. */
  quality: nilable(z.number().int().min(0).max(10)),
  item_level: nilable(z.number().int().min(0).max(1000)),
  /** Required character level. 0 when the item has none. */
  min_level: nilable(z.number().int().min(0).max(100)),
  /** Equip location token, e.g. "INVTYPE_CHEST". Only items that can be equipped have one. */
  equip_loc: nilable(z.string().min(1).max(ITEM_TEXT_MAX_LENGTH)),
  /** Localised item type, e.g. "Armor". */
  type: nilable(z.string().max(ITEM_TEXT_MAX_LENGTH)),
  /** Localised item subtype, e.g. "Mail". */
  sub_type: nilable(z.string().max(ITEM_TEXT_MAX_LENGTH)),
  /** Vendor price of one item, in copper. */
  sell_price: nilable(z.number().int().min(0).max(2_147_483_647)),
  stats: nilable(itemStatsSchema),
};

/**
 * Every stack of one item across the backpack and bags, summed. Items that
 * can be equipped are summed per item link, because two items with one ID can
 * differ in their random suffix and so in their stats.
 */
export const bagItemSchema = z.object({
  item_id: nilable(z.number().int().positive()),
  name: nilable(z.string()),
  /** Null when the stack size of any contributing slot was unreadable. */
  count: nilable(z.number().int().positive()),
  ...itemDetailShape,
});

/** One filled equipment slot. Empty slots are left out. */
export const equippedItemSchema = z.object({
  /** Inventory slot name as passed to `GetInventorySlotInfo`, e.g. "HeadSlot". */
  slot: z.string().min(1),
  item_id: nilable(z.number().int().positive()),
  name: nilable(z.string()),
  ...itemDetailShape,
});

/** Largest `inventory.items_pending`. */
export const ITEMS_PENDING_MAX = 1000;

export const inventorySchema = z.object({
  items: list(bagItemSchema),
  equipped: list(equippedItemSchema),
  /**
   * Distinct item links in the bags and the equipment whose details the
   * adapter did not read: the client had not cached the item yet (right after
   * login), the read failed, or the client has no item info API. Such an item
   * has no `equip_loc`, so a consumer cannot tell which slot it fits. While
   * this is above 0 a gear comparison is incomplete.
   */
  items_pending: nilable(z.number().int().min(0).max(ITEMS_PENDING_MAX)),
});

/** Most entries of `skills.lines`. A Classic Era character has about 30. */
export const SKILLS_MAX = 100;
/** Longest skill name and header name. */
export const SKILL_NAME_MAX_LENGTH = 60;
/** Largest skill rank, maximum rank, and absolute modifier. */
export const SKILL_RANK_MAX = 1000;

/**
 * The group a skill line is in, from the header row above it in the Skills
 * tab. `profession` is a primary profession (Mining, Tailoring), `secondary`
 * is Cooking, First Aid, or Fishing. `defense` is the Defense skill, which the
 * client lists with the weapon skills. `other` is a line under a header the
 * adapter does not recognise.
 */
export const SKILL_CATEGORIES = ["profession", "secondary", "weapon", "defense", "class", "armor", "language", "other"] as const;

/** One skill line of the Skills tab. Header rows are not lines. */
export const skillSchema = z.object({
  /** Localised skill name, e.g. "Mining". The adapter skips a line without one. */
  name: z.string().min(1).max(SKILL_NAME_MAX_LENGTH),
  category: z.enum(SKILL_CATEGORIES),
  /** Localised name of the header row above the line, e.g. "Professions". */
  header: nilable(z.string().min(1).max(SKILL_NAME_MAX_LENGTH)),
  /** Current rank, without gear and racial bonuses. */
  rank: nilable(z.number().int().min(0).max(SKILL_RANK_MAX)),
  /** Highest rank the player can reach before training the next level. */
  max_rank: nilable(z.number().int().min(0).max(SKILL_RANK_MAX)),
  /** Bonus from gear, buffs, and race, e.g. +15 Fishing from a fishing pole. */
  modifier: nilable(z.number().int().min(-SKILL_RANK_MAX).max(SKILL_RANK_MAX)),
});

/**
 * Skill lines: professions, secondary skills, weapon skills, Defense, and the
 * rest of the Skills tab, in the tab's order.
 */
export const skillsSchema = z.object({
  lines: list(skillSchema).refine((lines) => lines.length <= SKILLS_MAX, {
    message: `at most ${SKILLS_MAX} skill lines`,
  }),
  /**
   * True when the list may be missing lines: a header the player collapsed in
   * the Skills tab hides its lines from the API, and the adapter never expands
   * a header. Also true when the adapter stopped at `SKILLS_MAX` lines.
   */
  partial: z.boolean(),
});

/**
 * One place in the `recent_path` breadcrumb (§6.3, RED-290): the fields of a
 * place in the prototype's `get_recent_path` that the client reports, named
 * like the location section.
 */
export const recentPathEntrySchema = z.object({
  /** `GetServerTime()` at the collection that saw the change, in Unix seconds. */
  captured_at: z.number().int().nonnegative(),
  map_id: nilable(z.number().int().nonnegative()),
  zone: z.string().min(1),
  subzone: nilable(z.string()),
  x: nilable(z.number().min(0).max(1)),
  y: nilable(z.number().min(0).max(1)),
  in_instance: nilable(z.boolean()),
});

/**
 * The sections (§6.3, §10.4). The adapter leaves out a section whose collector
 * failed with no earlier value to keep, so every section is `nilable`.
 */
export const stateSchema = z.object({
  character: nilable(characterSchema),
  location: nilable(locationSchema),
  quests: nilable(questsSchema),
  inventory: nilable(inventorySchema),
  skills: nilable(skillsSchema),
  /**
   * Places, oldest first. The adapter keeps the newest 20, a proposed value
   * (RED-290), so the list has no bound here beyond the reader's value limit.
   */
  recent_path: nilable(list(recentPathEntrySchema)),
});

/** OpenGamerMCPDB. `schema` is checked before the rest (index.ts). */
export const dbSchema = z.object({
  /** The adapter schema version. */
  schema: z.number().int(),
  addon_version: nilable(z.string().min(1)),
  client: nilable(clientSchema),
  character: nilable(characterKeySchema),
  /**
   * `GetServerTime()` when the adapter wrote the table, in Unix seconds. The
   * adapter writes 0 when it has no server time. A stamp out of range reads as
   * unknown (index.ts).
   */
  captured_at: nilable(z.number().int()),
  state: stateSchema,
});

export type Client = z.output<typeof clientSchema>;
/** The WoW kit's snapshot state. Its top-level keys are the sections. */
export type WowState = z.output<typeof stateSchema>;
