// The WoW kit's interpreter (docs/architecture.md §6.2). It parses the
// adapter's SavedVariables file, OpenGamerMCP.lua (§6.3), into a snapshot.
// Pure: no DB or network.
import { ParseError, type Interpreter, type Parsed } from "@ogmcp/sdk";
import type { z } from "zod";
import { detect } from "./detect.js";
import { readSavedVariables, type ReadLimits } from "./lua.js";
import { dbSchema, type WowState } from "./schema.js";

export type { Client, WowState } from "./schema.js";

/** The manifest's only source (kits/wow/manifest.json). */
const SOURCE_ID = "savedvariables";
const FILE_NAME = "OpenGamerMCP.lua";
/** The table the adapter's TOC declares as its SavedVariables. */
const DB_NAME = "OpenGamerMCPDB";

/** The adapter schema the adapter in kits/wow/adapter writes (Storage.lua). */
export const ADAPTER_SCHEMA = 1;

/**
 * The adapter schemas `parse` accepts: the current one and the one before it,
 * because the addon can lag the server (§6.2, §7). Schema 1 is the first, so
 * there is no previous one yet. When the adapter moves to schema 2, add
 * `ADAPTER_SCHEMA - 1` here.
 */
const ACCEPTED_SCHEMAS: readonly number[] = [ADAPTER_SCHEMA];

export type ParseLimits = ReadLimits;

/**
 * The proposed limits (§6.2): the 5 MB upload cap (§8.3), 32 levels of
 * nesting, and 200k values. They are config: pass others to
 * `createInterpreter`.
 */
export const DEFAULT_LIMITS: Readonly<ParseLimits> = {
  maxBytes: 5 * 1024 * 1024,
  maxDepth: 32,
  maxValues: 200_000,
};

/** The WoW kit's interpreter, with `limits` in place of the defaults it names. */
export function createInterpreter(limits: Partial<ParseLimits> = {}): Interpreter<WowState> {
  const resolved: ParseLimits = {
    maxBytes: limits.maxBytes ?? DEFAULT_LIMITS.maxBytes,
    maxDepth: limits.maxDepth ?? DEFAULT_LIMITS.maxDepth,
    maxValues: limits.maxValues ?? DEFAULT_LIMITS.maxValues,
  };
  return {
    parse: (sourceId, bytes) => parse(sourceId, bytes, resolved),
    // The kit's MCP tools come in P6 (§10.4).
    tools: [],
  };
}

/** The WoW kit's interpreter with the default limits. */
export const interpreter: Interpreter<WowState> = createInterpreter();

function parse(sourceId: string, bytes: Uint8Array, limits: ParseLimits): Parsed<WowState> {
  if (sourceId !== SOURCE_ID) {
    throw new ParseError(`The WoW kit has no source "${sourceId}".`);
  }
  const db = readSavedVariables(bytes, limits, FILE_NAME).get(DB_NAME);
  if (db === undefined) {
    throw new ParseError(`${FILE_NAME} holds no Open Gamer MCP data yet. Type /transmit in game to save it.`);
  }
  checkSchema(typeof db === "object" && !Array.isArray(db) ? db["schema"] : undefined);

  const result = dbSchema.safeParse(db);
  if (!result.success) {
    throw new ParseError(describeIssue(result.error));
  }
  const { schema, client, character, captured_at, state } = result.data;
  const { flavor, rules } = detect(client);
  return {
    flavor,
    rules,
    // The GUID is the character key (§6.3), so a character without one has no key.
    character: character?.guid ? { key: character.guid, name: character.name, realm: character.realm } : null,
    capturedAt: captured_at === null ? null : new Date(captured_at * 1000),
    adapterSchema: schema,
    state,
  };
}

function checkSchema(schema: unknown): void {
  if (typeof schema !== "number" || !Number.isSafeInteger(schema)) {
    throw new ParseError(`${FILE_NAME} has no data format number. Type /transmit in game to save it again.`);
  }
  if (ACCEPTED_SCHEMAS.includes(schema)) {
    return;
  }
  const accepted = `${ACCEPTED_SCHEMAS.length === 1 ? "format" : "formats"} ${ACCEPTED_SCHEMAS.join(" and ")}`;
  if (schema > ADAPTER_SCHEMA) {
    throw new ParseError(
      `Your Open Gamer MCP addon saves data format ${schema}, and the server reads ${accepted}. The server does not read the newer format yet.`,
    );
  }
  throw new ParseError(
    `Your Open Gamer MCP addon is out of date: it saves data format ${schema}, and the server reads ${accepted}. Update the addon.`,
  );
}

/** A user-facing message for the first schema violation, naming where it is. */
function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) {
    return `${FILE_NAME} holds data the server does not accept.`;
  }
  const path = [DB_NAME, ...issue.path.map(String)].join(".");
  return `${FILE_NAME} holds data the server does not accept, at ${path}: ${issue.message}.`;
}
