// Flavor and rules detection (docs/architecture.md §6.3.1).
import type { UnknownFlavor } from "@ogremcp/sdk";
import type { Client } from "./schema.js";

export interface Detection {
  /** A flavor key, e.g. "classic_era", or "unknown". */
  flavor: string;
  /** E.g. ["hardcore"]; [] on normal realms. */
  rules: string[];
  /** Set only when `flavor` is "unknown", for the platform to log. */
  unknownFlavor?: UnknownFlavor;
}

/**
 * `WOW_PROJECT_*`. MAINLINE and CLASSIC are given in §6.3.1. The others are
 * from FrameXML, in Gethe/wow-ui-source:
 * - BURNING_CRUSADE_CLASSIC: @1463c686 (branch classic_anniversary, 2.5.6.69795),
 *   Interface/AddOns/Blizzard_FrameXMLBase/TBC/Constants.lua line 93.
 * - MISTS_CLASSIC: @cde55d00 (branch classic, 5.5.4.69934),
 *   Interface/AddOns/Blizzard_FrameXMLBase/Mists/Constants.lua line 160.
 * The Classic Era client reports the same values
 * (bttf/wow-guide@df80260:docs/api-probe.md, "Project constants").
 */
const PROJECT = {
  MAINLINE: 1,
  CLASSIC: 2,
  BURNING_CRUSADE_CLASSIC: 5,
  MISTS_CLASSIC: 19,
} as const;

/**
 * `Enum.SeasonID` (§6.3.1), as in Gethe/wow-ui-source@33e177d9 (branch
 * classic_era, 1.15.9.69722),
 * Interface/AddOns/Blizzard_APIDocumentationGenerated/SeasonsConstantsDocumentation.lua.
 */
const SEASON = {
  NO_SEASON: 0,
  SEASON_OF_MASTERY: 1,
  SEASON_OF_DISCOVERY: 2,
  HARDCORE: 3,
  FRESH: 11,
  FRESH_HARDCORE: 12,
} as const;

/**
 * The `interface` numbers each flavor's client reports, inclusive: its major
 * version (§6.3.1 "Sanity check"). An interface number is major * 10000 +
 * minor * 100 + patch, e.g. 11509 for 1.15.9. Classic Era and Season of
 * Discovery run the 1.15 client, Forever reports 16001 for 1.60.1
 * (bttf/wow-guide@df80260:docs/api-probe.md), and retail's two-digit major
 * gives six digits. TBC Classic reports 2xxxx and Mists Classic 5xxxx
 * (20506 and 50504 in https://warcraft.wiki.gg/wiki/Template:API_LatestInterface
 * on 2026-09-24).
 */
const INTERFACE: Readonly<Record<string, readonly [min: number, max: number]>> = {
  classic_era: [11000, 11999],
  classic_sod: [11000, 11999],
  tbc_classic: [20000, 29999],
  mists_classic: [50000, 59999],
  forever: [16000, 16999],
  retail: [100000, 999999],
};

interface Row {
  project: number;
  /** The row matches only this season, with nil read as NoSeason. Absent: any season. */
  season?: number;
  /** The row matches only an `interface` in its flavor's range. */
  keyedOnInterface?: true;
  flavor: string;
  rules: readonly string[];
}

/** The §6.3.1 table, matched top to bottom. */
const ROWS: readonly Row[] = [
  { project: PROJECT.CLASSIC, season: SEASON.NO_SEASON, flavor: "classic_era", rules: [] },
  { project: PROJECT.CLASSIC, season: SEASON.HARDCORE, flavor: "classic_era", rules: ["hardcore"] },
  { project: PROJECT.CLASSIC, season: SEASON.FRESH, flavor: "classic_era", rules: ["fresh"] },
  { project: PROJECT.CLASSIC, season: SEASON.FRESH_HARDCORE, flavor: "classic_era", rules: ["fresh", "hardcore"] },
  { project: PROJECT.CLASSIC, season: SEASON.SEASON_OF_DISCOVERY, flavor: "classic_sod", rules: [] },
  // Season of Mastery is retired.
  { project: PROJECT.CLASSIC, season: SEASON.SEASON_OF_MASTERY, flavor: "unknown", rules: [] },
  { project: PROJECT.BURNING_CRUSADE_CLASSIC, flavor: "tbc_classic", rules: [] },
  { project: PROJECT.MISTS_CLASSIC, flavor: "mists_classic", rules: [] },
  // Forever reports the retail project ID, so its row is keyed on `interface`.
  { project: PROJECT.MAINLINE, keyedOnInterface: true, flavor: "forever", rules: [] },
  { project: PROJECT.MAINLINE, flavor: "retail", rules: [] },
];

/**
 * Maps the adapter's raw client facts to a flavor and rules. `client` is null
 * when the adapter could not read them. A flavor the manifest does not
 * register keeps its name; ingest rejects it as `unsupported_flavor` (§8.3).
 */
export function detect(client: Client | null): Detection {
  if (client === null) {
    return unknown("the upload has no client facts", null);
  }
  const season = client.season_id ?? SEASON.NO_SEASON;
  const row = ROWS.find(
    (r) =>
      r.project === client.project_id &&
      (r.season === undefined || r.season === season) &&
      (!r.keyedOnInterface || inRange(r.flavor, client.interface)),
  );
  if (row === undefined) {
    return unknown("no row matches", client);
  }
  if (row.flavor === "unknown") {
    return unknown("Season of Mastery is retired", client);
  }
  if (!inRange(row.flavor, client.interface)) {
    return unknown(`interface ${client.interface} does not match ${row.flavor}`, client);
  }
  return { flavor: row.flavor, rules: [...row.rules] };
}

function inRange(flavor: string, iface: number | null): boolean {
  const range = INTERFACE[flavor];
  return range !== undefined && iface !== null && iface >= range[0] && iface <= range[1];
}

function unknown(reason: string, client: Client | null): Detection {
  return { flavor: "unknown", rules: [], unknownFlavor: { reason, facts: client === null ? null : { ...client } } };
}
