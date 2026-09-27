// The interpreter against the owner's two saves (fixtures/, §6.6.5) and
// against cut-short files.
import { readFileSync } from "node:fs";
import { ParseError } from "@ogremcp/sdk";
import { describe, expect, it } from "vitest";
import { interpreter, NOT_A_SAVE_MESSAGE } from "./index.js";

function fixture(name: string): Uint8Array {
  return readFileSync(new URL(`../fixtures/${name}/BALDUR.gam`, import.meta.url));
}

const parse = (bytes: Uint8Array) => interpreter.parse("gam", bytes);

describe.each([
  {
    fixture: "chapter4",
    game: { chapter: 4, day: 67, hour: 12, gold: 12006, reputation: 14, area: { code: "AR4802", name: "Temple of Helm" } },
    party: ["Buhldozier", "Khalid", "Imoen", "Jaheira", "Xan", "Viconia"],
    open: [
      "The Firewine Ruins",
      "Spiders in the Cloakwood",
      "Coran the Wyvern Hunter",
      "Important Events",
      "A Hidden Base in the Cloakwood",
      "A Hidden Base?",
      "Vai's Bounty Upon Bandits",
      "Madness Most Fowl",
      "Kivan's bandit hunt",
      "Gurke's Cloak",
      "Joseph's Wife",
      "The Mage's School",
    ],
    formerParty: ["Coran", "Kagain", "Dynaheir", "Minsc", "Branwen", "Montaron", "Xzar", "Kivan"],
  },
  {
    fixture: "chapter1",
    game: { chapter: 1, day: 1, hour: 7, gold: 75, reputation: 11, area: { code: "AR2700", name: "Lion's Way" } },
    party: ["Buhldozier"],
    open: ["Important Events"],
    formerParty: [],
  },
])("the $fixture fixture", ({ fixture: name, game, party, open, formerParty }) => {
  it("parses into the §6.2 Parsed shape with the §6.6.4 sections", () => {
    const parsed = parse(fixture(name));
    const { state } = parsed;

    expect(parsed).toMatchObject({
      flavor: "bgee",
      rules: [],
      character: { key: "Buhldozier", name: "Buhldozier", realm: "" },
      capturedAt: null,
      adapterSchema: 0,
    });
    expect(state.game).toEqual(game);
    expect(state.party.map((member) => member.name)).toEqual(party);
    expect(state.party.map((member) => member.protagonist)).toEqual(party.map((_, i) => i === 0));
    expect(state.inventory.map((member) => member.name)).toEqual(party);
    expect(state.quests.open.map((quest) => quest.title)).toEqual(open);
    expect(state.former_party.map((member) => member.name)).toEqual(formerParty);
    // Journal times are 15 ticks per game time unit: no entry is later than the save.
    const entries = [...state.quests.open, ...state.quests.completed].flatMap((quest) => quest.entries).concat(state.quests.other);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.day).toBeLessThanOrEqual(game.day);
    // JSON-serializable, and no U+0000 anywhere (§6.2).
    expect(JSON.parse(JSON.stringify(parsed.state))).toEqual(parsed.state);
    expect(JSON.stringify(parsed)).not.toContain("\\u0000");
  });
});

it("reads the chapter 4 party's classes, kits, and levels", () => {
  const { party } = parse(fixture("chapter4")).state;
  expect(party[0]).toMatchObject({
    class: { id: 8, name: "Fighter / Cleric" },
    kit: null,
    race: { name: "Half-Orc" },
    levels: [{ class: "Fighter", level: 4 }, { class: "Cleric", level: 4 }],
    base_thief_skills: null,
  });
  expect(party.find((member) => member.name === "Xan")).toMatchObject({ kit: { id: 512, name: "Enchanter" }, levels: [{ class: "Mage", level: 4 }] });
});

describe("a file that is not a whole save", () => {
  const whole = fixture("chapter4");
  // The journal is the last part the interpreter reads.
  const view = new DataView(whole.buffer, whole.byteOffset, whole.byteLength);
  const journalEnd = view.getUint32(0x50, true) + view.getUint32(0x4c, true) * 12;

  it("is a ParseError at every length that cuts off a part the interpreter reads", () => {
    for (let length = 8; length < journalEnd; length += 997) {
      expect(() => parse(whole.subarray(0, length)), `cut at ${length} bytes`).toThrow(ParseError);
    }
    const error = (() => {
      try {
        parse(whole.subarray(0, journalEnd - 1));
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ParseError);
    expect(error).toMatchObject({ message: expect.stringMatching(/^This Baldur's Gate save is cut short or damaged: the journal/), adapterSchema: 0, flavor: "bgee" });
  });

  it("is a ParseError without the GAME V2.0 signature", () => {
    for (const bytes of [new Uint8Array(0), whole.subarray(0, 7), new TextEncoder().encode("GAMEV1.1 and more")]) {
      expect(() => parse(bytes)).toThrow(new ParseError(NOT_A_SAVE_MESSAGE));
    }
  });
});
