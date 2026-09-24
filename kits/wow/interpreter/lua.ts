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
// (tables included, keys not) are capped. Going over is a ParseError. The
// upload is untrusted and parsed on the server's event loop, so time and
// memory stay linear in its size: numerals are scanned by hand, never by a
// backtracking regex, and strings with escapes share one byte buffer.

import type { ParseError } from "@ogmcp/sdk";
import { parseError, QUOTE_MAX } from "./errors.js";

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

/** The names that are data. Any other name is code or a variable. */
const LITERAL_NAMES = ["true", "false", "nil"];

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function isHexDigit(c: number): boolean {
  return isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
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
    throw parseError(`${fileName} is larger than ${size}, the most the server reads.`);
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
  /**
   * The bytes of the string being read, when it has escapes. One buffer for
   * every string, grown by doubling, so an escape costs one byte.
   */
  private buffer = new Uint8Array(256);

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
      throw parseError(`${this.fileName} holds more than ${this.limits.maxValues} values, more than the server reads.`);
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
      throw parseError(
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
    // Bytes in this.buffer. A string without escapes is decoded in place.
    let length = 0;
    let escaped = false;
    let run = this.pos;
    for (;;) {
      const c = this.peek();
      if (c === quote) {
        const end = this.pos;
        this.pos++;
        if (!escaped) {
          return this.decoder.decode(this.bytes.subarray(run, end));
        }
        length = this.append(length, run, end);
        return this.decoder.decode(this.buffer.subarray(0, length));
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
      escaped = true;
      length = this.append(length, run, this.pos);
      this.pos++;
      const byte = this.escape();
      this.reserve(length + 1);
      this.buffer[length++] = byte;
      run = this.pos;
    }
  }

  /** Copies the file's bytes from `start` to `end` into the buffer at `length`. */
  private append(length: number, start: number, end: number): number {
    if (end > start) {
      this.reserve(length + end - start);
      this.buffer.set(this.bytes.subarray(start, end), length);
    }
    return length + end - start;
  }

  private reserve(capacity: number): void {
    if (capacity > this.buffer.length) {
      const grown = new Uint8Array(Math.max(capacity, this.buffer.length * 2));
      grown.set(this.buffer);
      this.buffer = grown;
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

  /**
   * Reads an unsigned numeral in one pass: hex digits after 0x, or digits
   * with an optional fraction and exponent. A letter, digit, "_", or "." right
   * after it makes it malformed, because the Lua 5.1 lexer takes those as part
   * of the numeral.
   */
  private number(): number {
    const start = this.pos;
    let valid: boolean;
    if (this.peek() === 0x30 && (this.peek(1) === 0x58 || this.peek(1) === 0x78)) {
      this.pos += 2;
      const digits = this.pos;
      while (isHexDigit(this.peek())) {
        this.pos++;
      }
      valid = this.pos > digits;
    } else {
      let digits = 0;
      for (; isDigit(this.peek()); digits++) {
        this.pos++;
      }
      if (this.peek() === DOT) {
        this.pos++;
        for (; isDigit(this.peek()); digits++) {
          this.pos++;
        }
      }
      valid = digits > 0;
      if (valid && (this.peek() === 0x45 || this.peek() === 0x65)) {
        this.pos++;
        if (this.peek() === PLUS || this.peek() === MINUS) {
          this.pos++;
        }
        const exponent = this.pos;
        while (isDigit(this.peek())) {
          this.pos++;
        }
        valid = this.pos > exponent;
      }
    }
    if (!valid || isNameChar(this.peek()) || this.peek() === DOT) {
      while (isNameChar(this.peek()) || this.peek() === DOT) {
        this.pos++;
      }
      throw this.syntax(`"${this.snippet(start, this.pos)}" is not a number`);
    }
    const value = Number(this.decoder.decode(this.bytes.subarray(start, this.pos)));
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

  /** The ASCII text from `start` to `end`, cut to QUOTE_MAX characters. */
  private snippet(start: number, end: number): string {
    const text = this.decoder.decode(this.bytes.subarray(start, Math.min(end, start + QUOTE_MAX)));
    return end - start > QUOTE_MAX ? `${text}…` : text;
  }

  /** The error for what starts at the current position. */
  private unexpected(): ParseError {
    if (this.atEnd()) {
      return this.syntax("the file ends in the middle of the data");
    }
    if (isNameStart(this.peek())) {
      let end = this.pos;
      while (isNameChar(this.bytes[end] ?? -1)) {
        end++;
      }
      const name = this.snippet(this.pos, end);
      // At the end of the file, a start of true, false, or nil was cut off.
      if (end === this.bytes.length && LITERAL_NAMES.some((literal) => literal.startsWith(name))) {
        return this.syntax("the file ends in the middle of the data");
      }
      return this.syntax(`unexpected "${name}": the server reads only data, never code or variables`);
    }
    const c = this.peek();
    const shown = c > SPACE && c < 0x7f ? `"${String.fromCharCode(c)}"` : `byte 0x${c.toString(16).padStart(2, "0")}`;
    return this.syntax(`unexpected ${shown}`);
  }

  private syntax(detail: string): ParseError {
    return parseError(
      `${this.fileName} could not be read: ${detail} (line ${this.line}). Type /transmit in game to save it again.`,
    );
  }
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
