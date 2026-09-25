// The gear comparison of `wow_get_state`'s inventory section
// (docs/architecture.md §10.4): per equipment slot, the equipped item and
// whether a bag item for the same slot is better.
//
// Adapted from bttf/wow-guide@df80260:cloud/src/mcpTools.ts (GEAR_MEASURES to
// summariseGear), without the detail levels (§10.5) and the text rendering.
// Item fields are the snapshot's snake_case ones, and the item level measure
// is `item_level`.
import type { WowState } from "./schema.js";

type Inventory = NonNullable<WowState["inventory"]>;
export type BagItem = Inventory["items"][number];
export type EquippedItem = Inventory["equipped"][number];
type Item = BagItem | EquippedItem;

/** What two items of one slot are compared on. */
export type GearMeasure = "armor" | "dps" | "item_level";

/**
 * - `better_in_bags`: at least one bag item that fits the slot beats the equipped item on `measure`.
 * - `none_better`: bag items were compared and none beats it. A tie is not better.
 * - `not_compared`: bag items fit the slot and none could be compared.
 * - `fills_empty_slot`: the slot is empty and a bag item fits it.
 * - `no_candidates`: no bag item fits the slot at the character's level.
 * - `incomplete`: the details of some items were not read, so a bag item that
 *   fits the slot, or a better one, may be missing. The inventory section puts
 *   it in place of `none_better` and `no_candidates`, which would claim more
 *   than the data holds.
 */
export type GearComparison = "better_in_bags" | "none_better" | "not_compared" | "fills_empty_slot" | "no_candidates" | "incomplete";

/** The equipment slots a bag item with this equip location can go in. */
const SLOTS_BY_EQUIP_LOC: Record<string, readonly string[]> = {
  INVTYPE_HEAD: ["HeadSlot"],
  INVTYPE_NECK: ["NeckSlot"],
  INVTYPE_SHOULDER: ["ShoulderSlot"],
  INVTYPE_BODY: ["ShirtSlot"],
  INVTYPE_CHEST: ["ChestSlot"],
  INVTYPE_ROBE: ["ChestSlot"],
  INVTYPE_WAIST: ["WaistSlot"],
  INVTYPE_LEGS: ["LegsSlot"],
  INVTYPE_FEET: ["FeetSlot"],
  INVTYPE_WRIST: ["WristSlot"],
  INVTYPE_HAND: ["HandsSlot"],
  INVTYPE_FINGER: ["Finger0Slot", "Finger1Slot"],
  INVTYPE_TRINKET: ["Trinket0Slot", "Trinket1Slot"],
  INVTYPE_CLOAK: ["BackSlot"],
  // Whether the character can hold a one-hand weapon in the off hand is not known, so it goes to the main hand.
  INVTYPE_WEAPON: ["MainHandSlot"],
  INVTYPE_2HWEAPON: ["MainHandSlot"],
  INVTYPE_WEAPONMAINHAND: ["MainHandSlot"],
  INVTYPE_WEAPONOFFHAND: ["SecondaryHandSlot"],
  INVTYPE_SHIELD: ["SecondaryHandSlot"],
  INVTYPE_HOLDABLE: ["SecondaryHandSlot"],
  INVTYPE_RANGED: ["RangedSlot"],
  INVTYPE_RANGEDRIGHT: ["RangedSlot"],
  INVTYPE_THROWN: ["RangedSlot"],
  INVTYPE_RELIC: ["RangedSlot"],
  INVTYPE_TABARD: ["TabardSlot"],
};

/** Slot order of a gear summary, for slots that are empty in the snapshot. */
const GEAR_SLOT_ORDER = [...new Set(Object.values(SLOTS_BY_EQUIP_LOC).flat())];

/**
 * Items of different groups are not compared: a two-hand weapon against a
 * one-hand weapon, a shield against an off-hand weapon. A group also names the
 * measure: `dps` for weapons, `armor` for armor pieces, and the item level for
 * the rest.
 */
const GROUP_BY_EQUIP_LOC: Record<string, { group: string; measure: GearMeasure }> = {
  INVTYPE_2HWEAPON: { group: "two-hand", measure: "dps" },
  INVTYPE_WEAPON: { group: "one-hand", measure: "dps" },
  INVTYPE_WEAPONMAINHAND: { group: "one-hand", measure: "dps" },
  INVTYPE_WEAPONOFFHAND: { group: "one-hand", measure: "dps" },
  INVTYPE_RANGED: { group: "ranged", measure: "dps" },
  INVTYPE_RANGEDRIGHT: { group: "ranged", measure: "dps" },
  INVTYPE_THROWN: { group: "ranged", measure: "dps" },
  INVTYPE_SHIELD: { group: "shield", measure: "armor" },
  INVTYPE_HOLDABLE: { group: "held", measure: "item_level" },
  INVTYPE_RELIC: { group: "relic", measure: "item_level" },
  ...Object.fromEntries(
    ["HEAD", "SHOULDER", "CHEST", "ROBE", "WAIST", "LEGS", "FEET", "WRIST", "HAND", "CLOAK"].map((loc) => [
      `INVTYPE_${loc}`,
      { group: "armor", measure: "armor" as const },
    ]),
  ),
  ...Object.fromEntries(
    ["NECK", "FINGER", "TRINKET", "BODY", "TABARD"].map((loc) => [`INVTYPE_${loc}`, { group: "other", measure: "item_level" as const }]),
  ),
};

function measured(item: Item, measure: GearMeasure): number | null {
  return measure === "item_level" ? item.item_level : (item.stats?.[measure] ?? null);
}

/**
 * Compares a bag item with the equipped item of its slot. The primary measure
 * of the group is used when both items have it, and the item level for that
 * pair otherwise. Null when the groups differ or neither measure is known on
 * both sides. The result names the measure, so two results are comparable only
 * when their measures match.
 */
function compareGear(equipped: Item, candidate: Item): { measure: GearMeasure; equippedValue: number; value: number } | null {
  const mine = GROUP_BY_EQUIP_LOC[equipped.equip_loc ?? ""];
  const theirs = GROUP_BY_EQUIP_LOC[candidate.equip_loc ?? ""];
  if (mine === undefined || theirs === undefined || mine.group !== theirs.group) return null;
  for (const measure of [theirs.measure, "item_level"] as const) {
    const equippedValue = measured(equipped, measure);
    const value = measured(candidate, measure);
    if (equippedValue !== null && value !== null) return { measure, equippedValue, value };
  }
  return null;
}

export interface SlotSummary {
  slot: string;
  equipped: EquippedItem | null;
  measure: GearMeasure | null;
  comparison: GearComparison;
  /** Bag items that fit the slot at the character's level. */
  candidates: number;
  notCompared: number;
  /** Bag items that fit the slot and need a higher level than the character has. */
  aboveLevel: number;
  better: { item: BagItem; measure: GearMeasure; value: number; equippedValue: number }[];
}

/**
 * One summary per filled slot, and one per empty slot that a bag item fits.
 * A bag item goes to one slot. With two slots (rings, trinkets) that is the
 * empty one, else the one whose item has the lower item level. Class and
 * proficiency are not in the data, so they are not checked. The required
 * level is.
 */
export function summariseGear(inventory: Inventory, level: number | null): SlotSummary[] {
  const bySlot = new Map<string, SlotSummary>();
  const summary = (slot: string, equipped: EquippedItem | null): SlotSummary => {
    let entry = bySlot.get(slot);
    if (entry === undefined) {
      entry = { slot, equipped, measure: null, comparison: "no_candidates", candidates: 0, notCompared: 0, aboveLevel: 0, better: [] };
      bySlot.set(slot, entry);
    }
    return entry;
  };
  for (const item of inventory.equipped) summary(item.slot, item);
  const mainHand = bySlot.get("MainHandSlot")?.equipped ?? null;

  for (const item of inventory.items) {
    const slots = SLOTS_BY_EQUIP_LOC[item.equip_loc ?? ""];
    if (slots === undefined) continue;
    const empty = slots.find((slot) => (bySlot.get(slot)?.equipped ?? null) === null);
    const weakest = [...slots].sort((a, b) => (bySlot.get(a)?.equipped?.item_level ?? 0) - (bySlot.get(b)?.equipped?.item_level ?? 0))[0];
    const slot = empty ?? weakest;
    if (slot === undefined) continue;
    const entry = summary(slot, null);
    if (level !== null && item.min_level !== null && item.min_level > level) {
      entry.aboveLevel++;
      continue;
    }
    entry.candidates++;
    // Nothing goes in the off hand beside a two-hand weapon.
    if (slot === "SecondaryHandSlot" && mainHand?.equip_loc === "INVTYPE_2HWEAPON") {
      entry.notCompared++;
      continue;
    }
    if (entry.equipped === null) continue;
    const compared = compareGear(entry.equipped, item);
    if (compared === null) {
      entry.notCompared++;
      continue;
    }
    // The primary measure wins over an item-level fallback of another pair.
    if (entry.measure === null || entry.measure === "item_level") entry.measure = compared.measure;
    if (compared.value > compared.equippedValue) entry.better.push({ item, ...compared });
  }

  for (const entry of bySlot.values()) {
    // An armor value and an item level are different units. Items compared on
    // the primary measure come first, and values are ordered within a measure.
    entry.better.sort((a, b) => Number(a.measure === "item_level") - Number(b.measure === "item_level") || b.value - a.value);
    // The measure of the first listed better item. Without one, the measure
    // of the slot's first comparison.
    entry.measure = entry.better[0]?.measure ?? entry.measure;
    if (entry.candidates === 0) entry.comparison = "no_candidates";
    else if (entry.better.length > 0) entry.comparison = "better_in_bags";
    else if (entry.notCompared === entry.candidates) entry.comparison = "not_compared";
    else if (entry.equipped === null) entry.comparison = "fills_empty_slot";
    else entry.comparison = "none_better";
  }
  const order = (slot: string) => GEAR_SLOT_ORDER.indexOf(slot) + 1 || GEAR_SLOT_ORDER.length + 1;
  const filled = inventory.equipped.map((item) => item.slot);
  return [...bySlot.values()].sort(
    (a, b) =>
      Number(a.equipped === null) - Number(b.equipped === null) ||
      (a.equipped === null ? order(a.slot) - order(b.slot) : filled.indexOf(a.slot) - filled.indexOf(b.slot)),
  );
}
