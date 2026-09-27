// Reads a BG:EE save's BALDUR.gam: GAM V2.0 with its embedded CRE V1.0
// records, at the offsets the IESDP gives (docs/architecture.md §6.6.5,
// https://gibberlings3.github.io/iesdp/). Every offset and count is checked
// against the file, or against its CRE record, before it is read: a read out
// of range, or a CRE record without its signature, throws Damaged, which
// `parse` turns into a ParseError. The result holds the save's codes;
// state.ts looks them up in the name tables.

/** A read past the end of the file or of a record, or a record in the wrong format. `what` names the part, for the player. */
export class Damaged extends Error {
  constructor(readonly what: string) {
    super(`${what} is out of range or in the wrong format`);
  }
}

/** The GAM V2.0 signature and version (0x00). */
export const GAM_SIGNATURE = "GAMEV2.0";
const CRE_SIGNATURE = "CRE V1.0";

const GAM_HEADER_SIZE = 0xb4;
const NPC_SIZE = 0x160;
const VARIABLE_SIZE = 0x54;
const JOURNAL_ENTRY_SIZE = 0x0c;
const CRE_HEADER_SIZE = 0x2d4;
const MEMORIZATION_INFO_SIZE = 0x10;
const MEMORIZED_SPELL_SIZE = 0x0c;
const ITEM_SIZE = 0x14;
/** Item slots before the selected weapon: equipment, quick items, 16 backpack slots, the magic weapon (IESDP, CRE V1.0). */
export const ITEM_SLOT_COUNT = 38;
const NO_ITEM = 0xffff;
/** A journal entry's location flag for a strref in dialog.tlk. Others point into the save's own note files. */
const TLK_LOCATION = 0xff;

const utf8 = new TextDecoder("utf-8");

/** Bounds-checked little-endian reads of `bytes[start, end)`, at offsets relative to `start`. */
export class Reader {
  private readonly view: DataView;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly start = 0,
    private readonly end = bytes.length,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get length(): number {
    return this.end - this.start;
  }

  /** Throws Damaged unless `size` bytes at `offset` lie inside the view. */
  check(offset: number, size: number, what: string): void {
    if (!(offset >= 0 && size >= 0 && offset + size <= this.length)) throw new Damaged(what);
  }

  u8(offset: number, what: string): number {
    this.check(offset, 1, what);
    return this.view.getUint8(this.start + offset);
  }

  u16(offset: number, what: string): number {
    this.check(offset, 2, what);
    return this.view.getUint16(this.start + offset, true);
  }

  i16(offset: number, what: string): number {
    this.check(offset, 2, what);
    return this.view.getInt16(this.start + offset, true);
  }

  u32(offset: number, what: string): number {
    this.check(offset, 4, what);
    return this.view.getUint32(this.start + offset, true);
  }

  i32(offset: number, what: string): number {
    this.check(offset, 4, what);
    return this.view.getInt32(this.start + offset, true);
  }

  /** A NUL-terminated string in a field of `size` bytes, as UTF-8. It holds no U+0000 (§6.2). */
  text(offset: number, size: number, what: string): string {
    this.check(offset, size, what);
    const field = this.bytes.subarray(this.start + offset, this.start + offset + size);
    const nul = field.indexOf(0);
    return utf8.decode(nul === -1 ? field : field.subarray(0, nul));
  }

  /** A resref (an 8-byte file name), upper case. */
  resref(offset: number, what: string): string {
    return this.text(offset, 8, what).trim().toUpperCase();
  }

  /** A view of `size` bytes at `offset`. */
  sub(offset: number, size: number, what: string): Reader {
    this.check(offset, size, what);
    return new Reader(this.bytes, this.start + offset, this.start + offset + size);
  }

  /**
   * The offsets of `count` records of `size` bytes from `offset`, after
   * checking they all lie inside the view. With no records, the offset is
   * not read, so it is not checked.
   */
  records(offset: number, count: number, size: number, what: string): number[] {
    if (count === 0) return [];
    this.check(offset, count * size, what);
    return Array.from({ length: count }, (_, i) => offset + i * size);
  }
}

export interface Gam {
  /** 300 per hour (0x08). */
  gameTime: number;
  gold: number;
  /** The party member whose area is the current one, 0 to 5, or -1 (0x1c). */
  activeMember: number;
  /** Reputation times 10 (0x54). */
  reputation: number;
  currentArea: string;
  /** In record order: `party[0]` is the protagonist, Player1 (§6.6.2). */
  party: Npc[];
  /** Records not in the party: every joinable character the game has placed, met or not. */
  others: Npc[];
  /** The CHAPTER global, or null when the save has none. */
  chapter: number | null;
  journal: JournalEntry[];
}

export interface Npc {
  /** 0 to 5, the portrait position; 0xffff out of the party (0x02). */
  partyOrder: number;
  /** The GAM's name field (0xc0). Only the protagonist's is set. */
  name: string;
  area: string;
  cre: Cre | null;
}

export interface Cre {
  /** Strref (0x08). */
  longName: number;
  flags: number;
  xp: number;
  /** Permanent status flags, STATE.IDS (0x20). */
  state: number;
  hp: number;
  maxHp: number;
  /** Natural armor class, before items (0x46). */
  armorClass: number;
  thac0: number;
  /** Death, wands, polymorph, breath, spells (0x54). */
  saves: number[];
  thief: { lockpicking: number; move_silently: number; find_traps: number; pick_pockets: number; hide_in_shadows: number; detect_illusion: number; set_traps: number };
  /** One per class of a multi-class, in the order of the class's IDS name (0x234). */
  levels: number[];
  abilities: { strength: number; strength_bonus: number; intelligence: number; wisdom: number; dexterity: number; constitution: number; charisma: number };
  /** A KIT.IDS value. */
  kit: number;
  race: number;
  class: number;
  gender: number;
  alignment: number;
  /** Upper case (0x280). */
  deathVariable: string;
  memorized: MemorizedSpell[];
  /** Per item slot (ITEM_SLOT_COUNT), the item in it or null. */
  slots: (Item | null)[];
}

export interface MemorizedSpell {
  code: string;
  /** 1 to 9. */
  level: number;
  /** 0 priest, 1 wizard, 2 innate. */
  type: number;
  /** Not yet cast since the last rest. */
  ready: boolean;
}

export interface Item {
  code: string;
  /** Quantity or charges, per ability. */
  charges: number[];
  identified: boolean;
}

export interface JournalEntry {
  strref: number;
  /** 15 per unit of game time (4500 per hour). */
  time: number;
  chapter: number;
  /** Bit 0 quest, bit 1 completed quest, bit 2 journal info; none, a note. */
  section: number;
}

/** The GAM's campaign (0x94) and loading progress (0x64): the flavor facts (§6.6.2). */
export function readFlavorFacts(gam: Reader): { campaign: string; loadingProgress: number } {
  gam.check(0, GAM_HEADER_SIZE, "the header");
  return { campaign: gam.text(0x94, 8, "the campaign"), loadingProgress: gam.u32(0x64, "the loading progress") };
}

/** The whole save. The signature is checked before. */
export function readGam(gam: Reader): Gam {
  gam.check(0, GAM_HEADER_SIZE, "the header");
  const npcs = (offset: number, count: number, list: string) =>
    gam.records(gam.u32(offset, list), gam.u32(offset + 4, list), NPC_SIZE, list).map((at, i) => readNpc(gam, at, `record ${i + 1} of ${list}`));
  return {
    gameTime: gam.u32(0x08, "the game time"),
    gold: gam.u32(0x18, "the party gold"),
    activeMember: gam.i16(0x1c, "the active party member"),
    reputation: gam.u32(0x54, "the reputation"),
    currentArea: gam.resref(0x58, "the current area"),
    party: npcs(0x20, 0x24, "the party list"),
    others: npcs(0x30, 0x34, "the list of characters out of the party"),
    chapter: readChapter(gam),
    journal: readJournal(gam),
  };
}

function readNpc(gam: Reader, at: number, what: string): Npc {
  const creOffset = gam.u32(at + 0x04, what);
  const creSize = gam.u32(at + 0x08, what);
  return {
    partyOrder: gam.u16(at + 0x02, what),
    name: gam.text(at + 0xc0, 32, what),
    area: gam.resref(at + 0x18, what),
    cre: creSize === 0 ? null : readCre(gam.sub(creOffset, creSize, `the character data of ${what}`), `the character data of ${what}`),
  };
}

function readCre(cre: Reader, what: string): Cre {
  cre.check(0, CRE_HEADER_SIZE, what);
  if (cre.text(0, 8, what) !== CRE_SIGNATURE) throw new Damaged(what);
  const u8 = (offset: number) => cre.u8(offset, what);
  return {
    longName: cre.u32(0x08, what),
    flags: cre.u32(0x10, what),
    xp: cre.u32(0x18, what),
    state: cre.u32(0x20, what),
    hp: cre.u16(0x24, what),
    maxHp: cre.u16(0x26, what),
    armorClass: cre.i16(0x46, what),
    thac0: u8(0x52),
    saves: [0x54, 0x55, 0x56, 0x57, 0x58].map(u8),
    thief: {
      lockpicking: u8(0x67),
      move_silently: u8(0x68),
      find_traps: u8(0x69),
      pick_pockets: u8(0x6a),
      hide_in_shadows: u8(0x45),
      detect_illusion: u8(0x64),
      set_traps: u8(0x65),
    },
    levels: [0x234, 0x235, 0x236].map(u8),
    abilities: {
      strength: u8(0x238),
      strength_bonus: u8(0x239),
      intelligence: u8(0x23a),
      wisdom: u8(0x23b),
      dexterity: u8(0x23c),
      constitution: u8(0x23d),
      charisma: u8(0x23e),
    },
    // The two 16-bit halves are stored swapped (IESDP, CRE V1.0 0x244).
    kit: (cre.u16(0x246, what) | (cre.u16(0x244, what) << 16)) >>> 0,
    race: u8(0x272),
    class: u8(0x273),
    gender: u8(0x275),
    alignment: u8(0x27b),
    deathVariable: cre.text(0x280, 32, what).trim().toUpperCase(),
    memorized: readMemorized(cre, what),
    slots: readSlots(cre, what),
  };
}

/**
 * The memorized spells, with the level and type of the memorization-info
 * entry that lists them. An entry whose index or count leaves the memorized
 * list is skipped.
 */
function readMemorized(cre: Reader, what: string): MemorizedSpell[] {
  const infos = cre.records(cre.u32(0x2a8, what), cre.u32(0x2ac, what), MEMORIZATION_INFO_SIZE, what);
  const spells = cre.records(cre.u32(0x2b0, what), cre.u32(0x2b4, what), MEMORIZED_SPELL_SIZE, what);
  const memorized: MemorizedSpell[] = [];
  for (const info of infos) {
    const level = cre.u16(info, what) + 1;
    const type = cre.u16(info + 0x06, what);
    const first = cre.u32(info + 0x08, what);
    const count = cre.u32(info + 0x0c, what);
    if (first + count > spells.length) continue;
    for (const at of spells.slice(first, first + count)) {
      memorized.push({ code: cre.resref(at, what), level, type, ready: (cre.u32(at + 0x08, what) & 1) === 1 });
    }
  }
  return memorized;
}

/** The item in each slot. A slot whose index leaves the item list is empty. */
function readSlots(cre: Reader, what: string): (Item | null)[] {
  const items = cre.records(cre.u32(0x2bc, what), cre.u32(0x2c0, what), ITEM_SIZE, what).map(
    (at): Item => ({
      code: cre.resref(at, what),
      charges: [cre.u16(at + 0x0a, what), cre.u16(at + 0x0c, what), cre.u16(at + 0x0e, what)],
      identified: (cre.u32(at + 0x10, what) & 1) === 1,
    }),
  );
  const slots = cre.u32(0x2b8, what);
  return Array.from({ length: ITEM_SLOT_COUNT }, (_, i) => {
    const index = cre.u16(slots + i * 2, what);
    return index === NO_ITEM ? null : (items[index] ?? null);
  });
}

/** The CHAPTER global: the only variable the kit reads (§6.6.4). */
function readChapter(gam: Reader): number | null {
  const what = "the variables";
  for (const at of gam.records(gam.u32(0x38, what), gam.u32(0x3c, what), VARIABLE_SIZE, what)) {
    if (gam.text(at, 32, what).trim().toUpperCase() === "CHAPTER") return gam.i32(at + 0x28, what);
  }
  return null;
}

/** The journal, in the save's order. Entries whose text is not in dialog.tlk (the player's own notes) are left out. */
function readJournal(gam: Reader): JournalEntry[] {
  const what = "the journal";
  return gam
    .records(gam.u32(0x50, what), gam.u32(0x4c, what), JOURNAL_ENTRY_SIZE, what)
    .filter((at) => gam.u8(at + 0x0b, what) === TLK_LOCATION)
    .map((at) => ({
      strref: gam.u32(at, what),
      time: gam.u32(at + 0x04, what),
      chapter: gam.u8(at + 0x08, what),
      section: gam.u8(at + 0x0a, what),
    }));
}
