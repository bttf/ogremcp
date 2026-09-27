// The BG1 kit's interpreter (docs/architecture.md §6.2, §6.6). It parses a
// Baldur's Gate: Enhanced Edition save, BALDUR.gam, into a snapshot, with
// names from the kit's name tables. The kit has no adapter: the save is the
// source. Pure: no DB or network.
import type { Interpreter, Parsed, UnknownFlavor } from "@ogremcp/sdk";
import { clip, parseError, QUOTE_MAX } from "./errors.js";
import { Damaged, GAM_SIGNATURE, type ReadLimits, readFlavorFacts, readGam, Reader, TooMany } from "./gam.js";
import { getState } from "./get-state.js";
import { type Bg1State, buildState } from "./state.js";
import { loadTables } from "./tables.js";

export type { ReadLimits } from "./gam.js";
export type { Bg1State } from "./state.js";

/** The manifest's only source (kits/bg1/manifest.json). */
const SOURCE_ID = "gam";

/** No adapter, so no adapter schema (§6.6.2). */
export const ADAPTER_SCHEMA = 0;

export const NOT_A_SAVE_MESSAGE = "This isn't a Baldur's Gate: Enhanced Edition save.";

/**
 * The proposed limits on record counts (§0). They are config: pass others to
 * `createInterpreter`. The owner's saves hold at most 36 characters out of
 * the party, 227 variables, 100 journal entries, and 17 spell levels, 12
 * memorized spells, 25 items, and 37 effects per party member.
 */
export const DEFAULT_LIMITS: Readonly<ReadLimits> = {
  otherCharacters: 500,
  variables: 20_000,
  journalEntries: 5_000,
  spellLevels: 64,
  memorizedSpells: 500,
  items: 500,
  effects: 1_000,
};

/** The BG1 kit's interpreter, with `limits` in place of the defaults it names. */
export function createInterpreter(limits: Partial<ReadLimits> = {}): Interpreter<Bg1State> {
  const resolved: ReadLimits = { ...DEFAULT_LIMITS, ...limits };
  return {
    parse: (sourceId, bytes) => parse(sourceId, bytes, resolved),
    tools: [getState],
  };
}

/** The BG1 kit's interpreter with the default limits. */
export const interpreter: Interpreter<Bg1State> = createInterpreter();

function parse(sourceId: string, bytes: Uint8Array, limits: ReadLimits): Parsed<Bg1State> {
  if (sourceId !== SOURCE_ID) {
    throw parseError(`The Baldur's Gate kit has no source "${clip(sourceId, QUOTE_MAX)}".`);
  }
  const gam = new Reader(bytes);
  if (gam.length < GAM_SIGNATURE.length || gam.text(0, GAM_SIGNATURE.length, "the signature") !== GAM_SIGNATURE) {
    throw parseError(NOT_A_SAVE_MESSAGE);
  }
  let facts: { adapterSchema: number; flavor?: string } = { adapterSchema: ADAPTER_SCHEMA };
  try {
    const detected = detect(readFlavorFacts(gam));
    facts = { ...facts, flavor: detected.flavor };
    const save = readGam(gam, limits);
    const protagonist = save.party[0]?.name ?? "";
    return {
      flavor: detected.flavor,
      rules: [],
      ...(detected.unknownFlavor && { unknownFlavor: detected.unknownFlavor }),
      // The save has no unique ID, so the protagonist's name is the key (§6.6.2).
      character: protagonist === "" ? null : { key: protagonist, name: protagonist, realm: "" },
      // The save holds no wall-clock time: the platform uses the file's mtime (§6.6.1).
      capturedAt: null,
      adapterSchema: ADAPTER_SCHEMA,
      state: buildState(save, loadTables()),
    };
  } catch (error) {
    if (error instanceof Damaged) {
      throw parseError(`This Baldur's Gate save is cut short or damaged: ${error.what} is missing or out of place. Save the game again.`, facts);
    }
    if (error instanceof TooMany) {
      throw parseError(`This Baldur's Gate save lists ${error.count} ${error.what}, and the server reads at most ${error.max}.`, facts);
    }
    throw error;
  }
}

/**
 * The flavor, from the campaign field and the loading-progress sanity check
 * (§6.6.2). A flavor the manifest does not register is not rejected here:
 * ingest checks the registry (§6.1, §8.3).
 */
function detect({ campaign, loadingProgress }: { campaign: string; loadingProgress: number }): { flavor: string; unknownFlavor?: UnknownFlavor } {
  const facts = { campaign, loading_progress: loadingProgress };
  // 0 and 1 are the BG1 and Tales of the Sword Coast XP limits; a BG2 save holds 2 or more.
  if (loadingProgress > 1) {
    return { flavor: "unknown", unknownFlavor: { reason: "loading progress above the BG1 limits", facts } };
  }
  const key = campaign.trim().toUpperCase();
  if (key === "") return { flavor: "bgee" };
  if (key === "SOD") return { flavor: "sod" };
  return { flavor: "unknown", unknownFlavor: { reason: "unknown campaign", facts } };
}
