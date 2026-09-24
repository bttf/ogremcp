// The §6.3.1 detection table, one case per row, plus nil and 0 seasons and a
// failed sanity check.
import { expect, it } from "vitest";
import { detect } from "./detect.js";
import type { Client } from "./schema.js";

const ERA = 11509;

function client(project_id: number, iface: number, season_id: number | null = null): Client {
  return { project_id, season_id, version: "x", build: "1", interface: iface };
}

it.each([
  ["Era, season nil", client(2, ERA), "classic_era", []],
  ["Era, season 0", client(2, ERA, 0), "classic_era", []],
  ["Era, Hardcore", client(2, ERA, 3), "classic_era", ["hardcore"]],
  ["Era, Fresh", client(2, ERA, 11), "classic_era", ["fresh"]],
  ["Era, FreshHardcore", client(2, ERA, 12), "classic_era", ["fresh", "hardcore"]],
  ["Season of Discovery", client(2, ERA, 2), "classic_sod", []],
  ["Season of Mastery", client(2, ERA, 1), "unknown", []],
  ["TBC Classic", client(5, 20506), "tbc_classic", []],
  ["Mists Classic", client(19, 50504, 0), "mists_classic", []],
  ["Forever", client(1, 16001), "forever", []],
  ["retail", client(1, 120100), "retail", []],
  ["another project", client(14, 40402), "unknown", []],
  ["an Era season not in the table", client(2, ERA, 4), "unknown", []],
  ["a failed sanity check: TBC reporting project 2", client(2, 20506), "unknown", []],
  ["no client facts", null, "unknown", []],
])("%s", (_, facts, flavor, rules) => {
  const detection = detect(facts);
  expect(detection).toMatchObject({ flavor, rules });
  if (flavor === "unknown") {
    expect(detection.unknownFlavor).toEqual({ reason: expect.any(String), facts });
  } else {
    expect(detection).not.toHaveProperty("unknownFlavor");
  }
});
