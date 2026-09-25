// `wow_get_history` (docs/architecture.md §10.4): the player's snapshots from
// `since` on, newest first. Paid only (§14). The result is one §10.5 envelope,
// the newest snapshot's `snapshot_at`, `flavor`, `rules`, and `character`,
// plus `snapshots`: each snapshot with its own envelope and the requested
// sections (sections.ts). It goes out as `structuredContent` and as the same
// JSON in a text block, trimmed to the size cap (§10.5).
import { jsonResult, type Snapshot, type ToolDef, userError, utf8Length } from "@ogmcp/sdk";
import {
  type Cut,
  cutBags,
  envelope,
  EXPERIMENTAL_FLAVORS,
  FOREVER_PATH_NOTE,
  hasDescriptions,
  type JsonObject,
  mostThatFit,
  readInput,
  stateRules,
  trimNote,
  withoutDescriptions,
} from "./get-state.js";
import type { WowState } from "./schema.js";
import { buildSections, type BuiltSections, type Section, SECTIONS } from "./sections.js";

/**
 * The most snapshots a call returns without `limit` (§10.4, *proposed*). The
 * kit cannot read the platform's config, so this is a constant; the
 * platform's `HISTORY_MAX_SNAPSHOTS` caps any `limit`.
 */
export const DEFAULT_HISTORY_LIMIT = 20;

/**
 * The sections of each snapshot without `sections`. With a full quest log and
 * full bags, one snapshot with every section is tens of KB, near the 40 KB
 * size cap (§10.5) on its own, so a history of every section would almost
 * always be trimmed to a few snapshots. Character and location are a few
 * hundred bytes each, so the default 20 fit, and they tell what changed over
 * time: level, money, and where the player went.
 */
export const HISTORY_DEFAULT_SECTIONS: readonly Section[] = ["character", "location"];

/**
 * The description, with `experimental` as the experimental flavors. It names
 * the game and carries the §10.5 behavior rules that act on game state, like
 * `wow_get_state`'s. Game text never goes here, only into results (§10.5).
 */
export function describeGetHistory(experimental: readonly string[]): string {
  return [
    "World of Warcraft: the player's past game states, newest first, from the snapshots their game saved from `since` on. For the latest state, call wow_get_state.",
    "`limit`, `flavor`, `character`, and `sections` narrow it; `sections` defaults to `character` and `location`.",
    "Each snapshot carries `snapshot_at` (when the game captured it), `flavor`, the realm's `rules`, and `character`; the result's own are the newest snapshot's.",
    ...stateRules(experimental),
  ].join(" ");
}

const NO_HISTORY_MESSAGE =
  "No World of Warcraft snapshot from that time on matches. Try an earlier since, or call wow_get_state for the latest snapshot.";

/**
 * An ISO-8601 date, or date and time with an optional offset. Groups 1 to 3
 * are the year, month, and day, group 4 the time, and group 5 the offset.
 */
const ISO_8601 = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/i;

const BAD_SINCE_MESSAGE = "since must be an ISO-8601 date or date and time, such as 2026-09-24 or 2026-09-24T18:00:00Z.";

export const getHistory: ToolDef<WowState> = {
  name: "wow_get_history",
  description: describeGetHistory(EXPERIMENTAL_FLAVORS),
  inputSchema: {
    type: "object",
    properties: {
      since: {
        type: "string",
        description: "An ISO-8601 date or date and time, such as `2026-09-24` or `2026-09-24T18:00:00Z`. A time without an offset is UTC.",
      },
      sections: {
        type: "array",
        items: { type: "string", enum: [...SECTIONS] },
        minItems: 1,
        description: "The sections of each snapshot. Default: character and location.",
      },
      flavor: {
        type: "string",
        description: "A flavor key, such as `classic_era` or `forever`. Default: every flavor.",
      },
      character: {
        type: "string",
        description: "A character's name or `Name-Realm`, case-insensitive. Default: every character.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        description: `The most snapshots to return. Default: ${DEFAULT_HISTORY_LIMIT}. The server has its own maximum.`,
      },
    },
    required: ["since"],
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  paidOnly: true,
  async handler(args, ctx) {
    const input = readInput(args, HISTORY_DEFAULT_SECTIONS);
    if (typeof input === "string") return userError(input);
    // readInput accepted `args`, so it is an object, or absent.
    const { since: rawSince, limit: rawLimit } = (args ?? {}) as { [name: string]: unknown };
    const since = readSince(rawSince);
    if (since === null) return userError(BAD_SINCE_MESSAGE);
    let limit = DEFAULT_HISTORY_LIMIT;
    if (rawLimit !== undefined && rawLimit !== null) {
      if (typeof rawLimit !== "number" || !Number.isSafeInteger(rawLimit) || rawLimit < 1) {
        return userError("limit must be a whole number of 1 or more.");
      }
      limit = rawLimit;
    }
    const { sections, ...query } = input;
    // An unknown or ambiguous character rejects with a user-facing error,
    // which the platform turns into an `isError` result (§6.2).
    const snapshots = await ctx.history({ ...query, since, limit });
    if (snapshots.length === 0) return userError(NO_HISTORY_MESSAGE);
    return jsonResult(historyResult(snapshots, sections, ctx.maxResultBytes));
  },
};

/** `since` as a Date, or null when it is not an ISO-8601 date or date and time. A time without an offset is UTC. */
function readSince(since: unknown): Date | null {
  if (typeof since !== "string") return null;
  const text = since.trim();
  const match = ISO_8601.exec(text);
  if (match === null) return null;
  // JavaScript rolls a day past the month's end, such as 2026-02-30, into
  // the next month. It refuses a bad time on its own.
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  // JavaScript reads a date alone as UTC but a date and time without an
  // offset as local time, which is the server's.
  const date = new Date(match[4] !== undefined && match[5] === undefined ? `${text}Z` : text);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** One snapshot of the result, with its sections as the result shows them. */
interface Entry {
  snapshot: Snapshot<WowState>;
  state: JsonObject;
}

/** The envelope of the newest snapshot, the notes, and each snapshot, trimmed to at most `maxBytes` of JSON (`trim`). */
function historyResult(snapshots: readonly Snapshot<WowState>[], sections: readonly Section[], maxBytes: number): JsonObject {
  const [newest] = snapshots;
  if (newest === undefined) throw new Error("historyResult needs a snapshot.");
  const forever = sections.includes("recent_path") && snapshots.some((snapshot) => snapshot.flavor === "forever");
  const notes = forever ? [FOREVER_PATH_NOTE] : [];
  const result = (entries: readonly Entry[], trimNote: string | null): JsonObject => {
    const all = trimNote === null ? notes : [...notes, trimNote];
    return {
      ...envelope(newest),
      ...(all.length > 0 && { notes: all }),
      snapshots: entries.map(({ snapshot, state }) => ({ ...envelope(snapshot), state })),
    };
  };
  const built = snapshots.map((snapshot) => ({ snapshot, sections: buildSections(snapshot.state, snapshot.flavor, sections) }));
  return trim(built, maxBytes, result);
}

/**
 * The result `build` makes of `built`, newest first, with JSON of at most
 * `maxBytes` (§10.5). Over the cap, the quest descriptions of every snapshot
 * are left out first. Then the oldest snapshots, down to the newest one.
 * Then the newest one's bag list is cut to the most items that fit, as
 * `wow_get_state` does. `build` gets a note that says what was left out and
 * suggests fewer sections. A result that does not fit even so is returned as
 * it is: the platform answers it with a user-facing error.
 */
function trim(
  built: readonly { snapshot: Snapshot<WowState>; sections: BuiltSections }[],
  maxBytes: number,
  build: (entries: readonly Entry[], trimNote: string | null) => JsonObject,
): JsonObject {
  const fits = (result: JsonObject) => utf8Length(JSON.stringify(result)) <= maxBytes;
  const full = build(built.map(({ snapshot, sections }) => ({ snapshot, state: sections })), null);
  if (fits(full)) return full;

  const descriptionsLeftOut = built.some(({ sections }) => hasDescriptions(sections));
  const kept = built.map(({ snapshot, sections }) => ({ snapshot, state: descriptionsLeftOut ? withoutDescriptions(sections) : sections }));
  const total = kept.length;
  const note = (shown: number, bags: Cut | null) =>
    trimNote("wow_get_history", { descriptionsLeftOut, snapshots: shown < total ? { shown, total } : null, bags });
  const cut = (shown: number) => build(kept.slice(0, shown), note(shown, null));
  const result = cut(mostThatFit(1, total, (shown) => fits(cut(shown))));
  const [newest] = kept;
  const inventory = built[0]?.sections.inventory;
  if (fits(result) || newest === undefined || !inventory || inventory.items.length === 0) return result;

  // Only the newest snapshot is left, and it is still over the cap.
  return cutBags(newest.state, inventory, (state, bags) => build([{ snapshot: newest.snapshot, state }], note(1, bags)), fits);
}
