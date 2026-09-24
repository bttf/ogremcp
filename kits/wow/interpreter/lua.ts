// A literal-only reader for SavedVariables files (docs/architecture.md §6.2).
//
// The client writes a SavedVariables file as global assignments, `Name =
// value`, where each value is a Lua 5.1 literal: a table constructor, a
// string, a number, true, false, or nil. The reader accepts that subset of Lua
// and nothing else. It never evaluates Lua: a name in a value position, a
// call, or an operator is a ParseError. Comments are skipped.
//
// It reads bytes, not text. A Lua string is a byte string and a decimal escape
// (\ddd) names one byte, so a string is decoded as UTF-8 once its bytes are
// complete. Invalid UTF-8 becomes U+FFFD, as in the prototype's reader
// (bttf/wow-guide@df80260:bridge/internal/extract/extract.go). An unknown
// escape yields the escaped byte, as Lua 5.1 does.
//
// Tables become JSON values. A table whose keys are exactly 1 to n becomes an
// array. Any other table becomes an object with string keys: a number key is
// written in decimal, a boolean key as "true" or "false". An empty table
// becomes an empty object; the section schemas read it as an empty list where
// they expect a list. A nil value leaves its key out, as in Lua.
//
// Limits: the file size, the table nesting depth, and the number of values
// (tables included, keys not) are capped. Going over is a ParseError.

import { ParseError } from "@ogmcp/sdk";

export type LuaValue = string | number | boolean | LuaValue[] | { [key: string]: LuaValue };

type LuaKey = string | number | boolean;

export interface ReadLimits {
  /** Largest file, in bytes. */
  maxBytes: number;
  /** Deepest table nesting. A table assigned to a global is at depth 1. */
  maxDepth: number;
  /** Most values in the file, tables included and keys not. */
  maxValues: number;
}

const MIB = 1024 * 1024;
/** Longest name quoted in an error message. */
const MESSAGE_NAME_MAX = 40;

const TAB = 0x09;
const LF = 0x0a;
const VT = 0x0b;
const FF = 0x0c;
const CR = 0x0d;
const SPACE = 0x20;
const DQUOTE = 0x22;
const SQUOTE = 0x27;
const PLUS = 0x2b;
const COMMA = 0x2c;
const MINUS = 0x2d;
const DOT = 0x2e;
const SEMICOLON = 0x3b;
const EQUALS = 0x3d;
const LBRACKET = 0x5b;
const BACKSLASH = 0x5c;
const RBRACKET = 0x5d;
const LBRACE = 0x7b;
const RBRACE = 0x7d;

/** Lua 5.1 single-letter escapes and the byte each one names. */
const ESCAPES: Record<string, number> = { a: 0x07, b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b };

const NUMBER = /^(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)$/;

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function isNameStart(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
}

function isNameChar(c: number): boolean {
  return isNameStart(c) || isDigit(c);
}

/**
 * Reads the global assignments of a SavedVariables file. Returns each global
 * that is not nil, by name. `fileName` names the file in error messages, which
 * are user-facing.
 */
export function readSavedVariables(bytes: Uint8Array, limits: ReadLimits, fileName: string): Map<string, LuaValue> {
  if (bytes.length > limits.maxBytes) {
    const size = Number.isInteger(limits.maxBytes / MIB) ? `${limits.maxBytes / MIB} MB` : `${limits.maxBytes} bytes`;
    throw new ParseError(`${fileName} is larger than ${size}, the most the server reads.`);
  }
  return new Reader(bytes, limits, fileName).file();
}

class Reader {
  private readonly bytes: Uint8Array;
  private readonly limits: ReadLimits;
  private readonly fileName: string;
  private readonly decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  private pos = 0;
  private line = 1;
  private values = 0;

  constructor(bytes: Uint8Array, limits: ReadLimits, fileName: string) {
    this.bytes = bytes;
    this.limits = limits;
    this.fileName = fileName;
  }

  file(): Map<string, LuaValue> {
    const globals = new Map<string, LuaValue>();
    // A UTF-8 byte order mark.
    if (this.peek() === 0xef && this.peek(1) === 0xbb && this.peek(2) === 0xbf) {
      this.pos = 3;
    }
    for (;;) {
      this.skipSpace();
      if (this.atEnd()) {
        return globals;
      }
      const start = this.pos;
      const name = this.name();
      this.skipSpace();
      if (name === null || this.peek() !== EQUALS || this.peek(1) === EQUALS) {
        this.pos = start;
        throw this.unexpected();
      }
      this.pos++;
      const value = this.value(0);
      if (value === undefined) {
        globals.delete(name);
      } else {
        globals.set(name, value);
      }
      this.skipSpace();
      if (this.peek() === SEMICOLON) {
        this.pos++;
      }
    }
  }

  /** Reads a table, string, number, or boolean; undefined for nil. */
  private value(depth: number): LuaValue | undefined {
    this.skipSpace();
    const value = this.peek() === LBRACE ? this.table(depth + 1) : this.scalar();
    if (value !== undefined && ++this.values > this.limits.maxValues) {
      throw new ParseError(`${this.fileName} holds more than ${this.limits.maxValues} values, more than the server reads.`);
    }
    return value;
  }

  /** Reads a string, number, true, or false; undefined for nil. */
  private scalar(): string | number | boolean | undefined {
    const c = this.peek();
    if (c === DQUOTE || c === SQUOTE) {
      return this.quoted();
    }
    if (c === LBRACKET && this.longBracketLevel() >= 0) {
      return this.longBracket();
    }
    if (this.atNumber()) {
      return this.number();
    }
    if (c === MINUS) {
      this.pos++;
      this.skipSpace();
      if (!this.atNumber()) {
        throw this.unexpected();
      }
      return -this.number();
    }
    const start = this.pos;
    switch (this.name()) {
      case "true":
        return true;
      case "false":
        return false;
      case "nil":
        return undefined;
      default:
        this.pos = start;
        throw this.unexpected();
    }
  }

  private table(depth: number): LuaValue {
    if (depth > this.limits.maxDepth) {
      throw new ParseError(
        `${this.fileName} nests tables more than ${this.limits.maxDepth} levels deep (line ${this.line}), more than the server reads.`,
      );
    }
    this.pos++;
    const entries = new Map<LuaKey, LuaValue>();
    let index = 0;
    for (;;) {
      this.skipSpace();
      if (this.peek() === RBRACE) {
        this.pos++;
        return toJson(entries);
      }
      let key: LuaKey;
      let value: LuaValue | undefined;
      if (this.peek() === LBRACKET && this.longBracketLevel() < 0) {
        // [key] = value
        this.pos++;
        this.skipSpace();
        const k = this.peek() === LBRACE ? undefined : this.scalar();
        if (k === undefined) {
          throw this.syntax("a table key must be a string, a number, true, or false");
        }
        key = k;
        this.skipSpace();
        this.expect(RBRACKET);
        this.skipSpace();
        this.expect(EQUALS);
        value = this.value(depth);
      } else {
        // name = value, or a list entry.
        const start = this.pos;
        const name = this.name();
        this.skipSpace();
        if (name !== null && this.peek() === EQUALS && this.peek(1) !== EQUALS) {
          this.pos++;
          key = name;
        } else {
          this.pos = start;
          key = ++index;
        }
        value = this.value(depth);
      }
      if (value === undefined) {
        entries.delete(key);
      } else {
        entries.set(key, value);
      }
      this.skipSpace();
      const c = this.peek();
      if (c === COMMA || c === SEMICOLON) {
        this.pos++;
      } else if (c !== RBRACE) {
        throw this.unexpected();
      }
    }
  }

  private quoted(): string {
    const quote = this.peek();
    this.pos++;
    const parts: Uint8Array[] = [];
    let run = this.pos;
    for (;;) {
      const c = this.peek();
      if (c === quote) {
        parts.push(this.bytes.subarray(run, this.pos));
        this.pos++;
        return this.decode(parts);
      }
      if (c === -1) {
        throw this.unexpected();
      }
      if (c === LF || c === CR) {
        throw this.syntax("a string is not closed");
      }
      if (c !== BACKSLASH) {
        this.pos++;
        continue;
      }
      parts.push(this.bytes.subarray(run, this.pos));
      this.pos++;
      parts.push(Uint8Array.of(this.escape()));
      run = this.pos;
    }
  }

  /** Reads the escape after a backslash and returns the byte it names. */
  private escape(): number {
    const c = this.peek();
    if (c === -1) {
      throw this.unexpected();
    }
    if (c === LF || c === CR) {
      // A backslash before a line break is a line break. \r\n and \n\r are one.
      this.pos++;
      const next = this.peek();
      if ((next === LF || next === CR) && next !== c) {
        this.pos++;
      }
      this.line++;
      return LF;
    }
    if (isDigit(c)) {
      let value = 0;
      for (let i = 0; i < 3 && isDigit(this.peek()); i++) {
        value = value * 10 + this.peek() - 0x30;
        this.pos++;
      }
      if (value > 255) {
        throw this.syntax("a string holds an escape above \\255");
      }
      return value;
    }
    this.pos++;
    return ESCAPES[String.fromCharCode(c)] ?? c;
  }

  /**
   * At `[`: the level of the long bracket that starts here, the number of `=`
   * between the brackets, or -1 when this is no long bracket.
   */
  private longBracketLevel(): number {
    let level = 0;
    while (this.peek(1 + level) === EQUALS) {
      level++;
    }
    return this.peek(1 + level) === LBRACKET ? level : -1;
  }

  /** Reads a long string or the body of a long comment. */
  private longBracket(): string {
    const level = this.longBracketLevel();
    this.pos += level + 2;
    // A line break right after the opening bracket is not part of the string.
    if (this.peek() === CR && this.peek(1) === LF) {
      this.pos += 2;
      this.line++;
    } else if (this.peek() === LF) {
      this.pos++;
      this.line++;
    }
    const start = this.pos;
    for (;;) {
      const c = this.peek();
      if (c === -1) {
        throw this.unexpected();
      }
      if (c === LF) {
        this.line++;
      } else if (c === RBRACKET) {
        let n = 0;
        while (this.peek(1 + n) === EQUALS) {
          n++;
        }
        if (n === level && this.peek(1 + n) === RBRACKET) {
          const text = this.decoder.decode(this.bytes.subarray(start, this.pos));
          this.pos += level + 2;
          return text;
        }
      }
      this.pos++;
    }
  }

  private atNumber(): boolean {
    const c = this.peek();
    return isDigit(c) || (c === DOT && isDigit(this.peek(1)));
  }

  /** Reads an unsigned number the way the Lua 5.1 lexer delimits one. */
  private number(): number {
    const start = this.pos;
    while (isDigit(this.peek()) || this.peek() === DOT) {
      this.pos++;
    }
    const c = this.peek();
    if (c === 0x45 || c === 0x65) {
      this.pos++;
      if (this.peek() === PLUS || this.peek() === MINUS) {
        this.pos++;
      }
    }
    while (isNameChar(this.peek())) {
      this.pos++;
    }
    const text = this.decoder.decode(this.bytes.subarray(start, this.pos));
    if (!NUMBER.test(text)) {
      throw this.syntax(`"${clip(text)}" is not a number`);
    }
    const value = Number(text);
    if (!Number.isFinite(value)) {
      throw this.syntax("a number is too large");
    }
    return value;
  }

  /** Reads a name, or returns null when none starts here. */
  private name(): string | null {
    if (!isNameStart(this.peek())) {
      return null;
    }
    const start = this.pos;
    while (isNameChar(this.peek())) {
      this.pos++;
    }
    return this.decoder.decode(this.bytes.subarray(start, this.pos));
  }

  /** Skips white space and comments, counting lines. */
  private skipSpace(): void {
    for (;;) {
      const c = this.peek();
      if (c === LF) {
        this.line++;
        this.pos++;
      } else if (c === SPACE || c === TAB || c === CR || c === VT || c === FF) {
        this.pos++;
      } else if (c === MINUS && this.peek(1) === MINUS) {
        this.pos += 2;
        if (this.peek() === LBRACKET && this.longBracketLevel() >= 0) {
          this.longBracket();
        } else {
          while (!this.atEnd() && this.peek() !== LF) {
            this.pos++;
          }
        }
      } else {
        return;
      }
    }
  }

  private expect(c: number): void {
    if (this.peek() !== c) {
      throw this.unexpected();
    }
    this.pos++;
  }

  /** The byte `offset` bytes ahead, or -1 past the end. */
  private peek(offset = 0): number {
    return this.bytes[this.pos + offset] ?? -1;
  }

  private atEnd(): boolean {
    return this.pos >= this.bytes.length;
  }

  private decode(parts: Uint8Array[]): string {
    if (parts.length === 1 && parts[0] !== undefined) {
      return this.decoder.decode(parts[0]);
    }
    let length = 0;
    for (const part of parts) {
      length += part.length;
    }
    const joined = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.length;
    }
    return this.decoder.decode(joined);
  }

  /** The error for what starts at the current position. */
  private unexpected(): ParseError {
    if (this.atEnd()) {
      return this.syntax("the file ends in the middle of the data");
    }
    const start = this.pos;
    const name = this.name();
    const cut = this.atEnd();
    this.pos = start;
    if (name !== null) {
      // A name that runs to the end of the file may be a cut-off `true`.
      return this.syntax(cut ? "the file ends in the middle of the data" : `"${clip(name)}" is code, and the server reads only data`);
    }
    const c = this.peek();
    const shown = c > SPACE && c < 0x7f ? `"${String.fromCharCode(c)}"` : `byte 0x${c.toString(16).padStart(2, "0")}`;
    return this.syntax(`unexpected ${shown}`);
  }

  private syntax(detail: string): ParseError {
    return new ParseError(
      `${this.fileName} could not be read: ${detail} (line ${this.line}). Type /transmit in game to save it again.`,
    );
  }
}

function clip(text: string): string {
  return text.length > MESSAGE_NAME_MAX ? `${text.slice(0, MESSAGE_NAME_MAX)}…` : text;
}

/** Turns a table's entries into an array when its keys are exactly 1 to n, else into an object. */
function toJson(entries: Map<LuaKey, LuaValue>): LuaValue {
  const n = entries.size;
  let sequence = n > 0;
  for (const key of entries.keys()) {
    if (typeof key !== "number" || !Number.isInteger(key) || key < 1 || key > n) {
      sequence = false;
      break;
    }
  }
  if (sequence) {
    const list = new Array<LuaValue>(n);
    for (const [key, value] of entries) {
      list[(key as number) - 1] = value;
    }
    return list;
  }
  // Object.fromEntries defines each key as an own property, so a key such as
  // "__proto__" cannot change the object's prototype.
  return Object.fromEntries(Array.from(entries, ([key, value]) => [String(key), value]));
}
