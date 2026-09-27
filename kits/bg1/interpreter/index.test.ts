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

it("reads the chapter 4 party's weapon proficiencies, without those at 0 pips", () => {
  const { party } = parse(fixture("chapter4")).state;
  expect(Object.fromEntries(party.map((member) => [member.name, member.base_proficiencies]))).toEqual({
    // War Hammer is at 0.
    Buhldozier: [{ name: "Flail / Morning Star", pips: 2 }, { name: "Sword and Shield Style", pips: 2 }, { name: "Two-Weapon Style", pips: 1 }],
    Khalid: [{ name: "Long Sword", pips: 3 }, { name: "Axe", pips: 1 }, { name: "Longbow", pips: 1 }],
    Imoen: [{ name: "Short Sword", pips: 1 }, { name: "Shortbow", pips: 1 }, { name: "Sword and Shield Style", pips: 1 }],
    // In ID order: the save lists Club first.
    Jaheira: [{ name: "Quarterstaff", pips: 1 }, { name: "Sling", pips: 2 }, { name: "Club", pips: 2 }],
    Xan: [{ name: "Dagger", pips: 1 }],
    Viconia: [{ name: "Mace", pips: 1 }, { name: "Sling", pips: 1 }, { name: "Sword and Shield Style", pips: 1 }],
  });
});

it("applies a proficiency effect's negative increment as a decrement, and leaves out pips below 1", () => {
  const bytes = new Uint8Array(fixture("chapter1"));
  const view = new DataView(bytes.buffer);
  // The protagonist's effects are EFF V2: after the ones that set Flail / Morning Star and
  // Sword and Shield Style to 2, turn the last two into increments of -5 and -1.
  const cre = view.getUint32(view.getUint32(0x20, true) + 0x04, true);
  const effects = cre + view.getUint32(cre + 0x2c4, true);
  for (const [index, amount, proficiency] of [[20, -5, 112], [21, -1, 100]] as const) {
    const at = effects + index * 0x108;
    view.setUint32(at + 0x08, 233, true);
    view.setInt32(at + 0x14, amount, true);
    view.setUint32(at + 0x18, 0x1_0000 | proficiency, true);
  }
  expect(parse(bytes).state.party[0]?.base_proficiencies).toEqual([{ name: "Flail / Morning Star", pips: 1 }]);
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

  it("is a ParseError, fast, when counts would multiply the work", { timeout: 1000 }, () => {
    const cases = [
      // One party member whose spell levels each list every memorized spell.
      { bytes: crafted(1, 150_000, { infos: 9_000, spells: 12_500 }), message: /lists 9000 spell levels in the character data of record 1 of the party list/ },
      // The same, within the limits: the spell levels list more spells than there are.
      { bytes: crafted(1, 150_000, { infos: 64, spells: 500 }), message: /cut short or damaged: the character data of record 1 of the party list/ },
      // 1,000 party records that share one character.
      { bytes: crafted(1_000, 1_000_000, {}), message: /lists 1000 party members, and the server reads at most 6/ },
    ];
    for (const { bytes, message } of cases) expect(() => parse(bytes)).toThrow(message);
  });

  it("is a ParseError when a party member's effect list is out of range", () => {
    const bytes = crafted(1, 10_000, {});
    expect(parse(bytes).state.party[0]?.base_proficiencies).toEqual([]);
    // One EFF V1 effect (0x30 bytes) that starts 0x10 bytes before the end.
    const cre = 0xb4 + 0x160;
    const view = new DataView(bytes.buffer);
    view.setUint32(cre + 0x2c4, bytes.length - cre - 0x10, true);
    view.setUint32(cre + 0x2c8, 1, true);
    expect(() => parse(bytes)).toThrow(/cut short or damaged: the character data of record 1 of the party list/);
  });

  it("is a ParseError without the GAME V2.0 signature", () => {
    for (const bytes of [new Uint8Array(0), whole.subarray(0, 7), new TextEncoder().encode("GAMEV1.1 and more")]) {
      expect(() => parse(bytes)).toThrow(new ParseError(NOT_A_SAVE_MESSAGE));
    }
  });
});

/**
 * A GAM of `size` bytes with `records` party records that all point to one
 * CRE, whose `infos` memorization-info entries each list all of its `spells`
 * memorized spells.
 */
function crafted(records: number, size: number, { infos = 0, spells = 0 }: { infos?: number; spells?: number }): Uint8Array {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  const u32 = (at: number, value: number) => view.setUint32(at, value, true);
  bytes.set(new TextEncoder().encode("GAMEV2.0"), 0);
  const party = 0xb4;
  const cre = party + records * 0x160;
  u32(0x20, party);
  u32(0x24, records);
  for (let i = 0; i < records; i++) {
    u32(party + i * 0x160 + 0x04, cre);
    u32(party + i * 0x160 + 0x08, size - cre);
  }
  bytes.set(new TextEncoder().encode("CRE V1.0"), cre);
  const infoAt = 0x2d4;
  u32(cre + 0x2a8, infoAt);
  u32(cre + 0x2ac, infos);
  u32(cre + 0x2b0, 0);
  u32(cre + 0x2b4, spells);
  for (let i = 0; i < infos; i++) u32(cre + infoAt + i * 16 + 0x0c, spells);
  return bytes;
}
