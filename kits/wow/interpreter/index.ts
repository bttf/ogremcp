// The WoW kit's interpreter (docs/architecture.md §6.2). It parses the
// adapter's SavedVariables file, OgreMCP.lua (§6.3), into a snapshot.
// Pure: no DB or network.
import type { Interpreter, Parsed } from "@ogremcp/sdk";
import type { z } from "zod";
import { detect } from "./detect.js";
import { clip, parseError, QUOTE_MAX } from "./errors.js";
import { getHistory } from "./get-history.js";
import { getState } from "./get-state.js";
import { readSavedVariables, type ReadLimits } from "./lua.js";
import { dbSchema, type WowState } from "./schema.js";

export type { Client, WowState } from "./schema.js";

/** The manifest's only source (kits/wow/manifest.json). */
const SOURCE_ID = "savedvariables";
const FILE_NAME = "OgreMCP.lua";
/** The table the adapter's TOC declares as its SavedVariables. */
const DB_NAME = "OgreMCPDB";

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

/** The earliest `captured_at` accepted: 2004-01-01, before WoW's release. */
const CAPTURED_AT_MIN = Date.UTC(2004, 0, 1) / 1000;
/** How far past `ParseOptions.now` a `captured_at` may be, in seconds. */
const CAPTURED_AT_AHEAD_MAX = 24 * 60 * 60;

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
    parse: (sourceId, bytes, options) => parse(sourceId, bytes, resolved, options?.now ?? new Date()),
    tools: [getState, getHistory],
  };
}

/** The WoW kit's interpreter with the default limits. */
export const interpreter: Interpreter<WowState> = createInterpreter();

function parse(sourceId: string, bytes: Uint8Array, limits: ParseLimits, now: Date): Parsed<WowState> {
  if (sourceId !== SOURCE_ID) {
    throw parseError(`The WoW kit has no source "${clip(sourceId, QUOTE_MAX)}".`);
  }
  const db = readSavedVariables(bytes, limits, FILE_NAME).get(DB_NAME);
  if (db === undefined) {
    throw parseError(`${FILE_NAME} holds no Ogre MCP data yet. Type /transmit in game to save it.`);
  }
  const table = typeof db === "object" && !Array.isArray(db) ? db : undefined;
  const adapterSchema = checkSchema(table?.["schema"]);

  // The flavor is detected before the rest is checked, so that a failure
  // elsewhere records it (§16.1). Client facts that fail their schema give none.
  const client = dbSchema.shape.client.safeParse(table?.["client"]);
  const detection = client.success ? detect(client.data) : undefined;

  const result = dbSchema.safeParse(db);
  if (!result.success) {
    throw parseError(describeIssue(result.error), { adapterSchema, ...(detection && { flavor: detection.flavor }) });
  }
  const { character, captured_at, state } = result.data;
  // A flavor the manifest does not register is not rejected here: ingest
  // checks the registry (§6.1, §8.3).
  const { flavor, rules, unknownFlavor } = detection ?? detect(result.data.client);
  return {
    flavor,
    rules,
    ...(unknownFlavor && { unknownFlavor }),
    // The GUID is the character key (§6.3), so a character without one has no key.
    character: character?.guid ? { key: character.guid, name: character.name, realm: character.realm } : null,
    capturedAt: capturedAt(captured_at, now),
    adapterSchema,
    state,
  };
}

/**
 * The adapter's stamp as a Date. A stamp before CAPTURED_AT_MIN (the adapter
 * writes 0 without a server time) or more than a day after `now` is
 * unknown: null, so the platform falls back to the bridge's mtime (§6.2).
 */
function capturedAt(stamp: number | null, now: Date): Date | null {
  if (stamp === null || stamp < CAPTURED_AT_MIN || stamp > now.getTime() / 1000 + CAPTURED_AT_AHEAD_MAX) {
    return null;
  }
  return new Date(stamp * 1000);
}

/**
 * The upload's adapter schema, when `parse` accepts it. Otherwise a
 * ParseError, which records the schema when it is an integer (§16.1).
 */
function checkSchema(schema: unknown): number {
  if (typeof schema !== "number" || !Number.isSafeInteger(schema)) {
    throw parseError(`${FILE_NAME} has no data format number. Type /transmit in game to save it again.`);
  }
  if (ACCEPTED_SCHEMAS.includes(schema)) {
    return schema;
  }
  const accepted = `${ACCEPTED_SCHEMAS.length === 1 ? "format" : "formats"} ${ACCEPTED_SCHEMAS.join(" and ")}`;
  if (schema > ADAPTER_SCHEMA) {
    throw parseError(
      `Your Ogre MCP addon saves data format ${schema}, and the server reads ${accepted}. The server does not read the newer format yet.`,
      { adapterSchema: schema },
    );
  }
  throw parseError(
    `Your Ogre MCP addon is out of date: it saves data format ${schema}, and the server reads ${accepted}. Update the addon.`,
    { adapterSchema: schema },
  );
}

/** A user-facing message for the first schema violation, naming where it is. */
function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) {
    return `${FILE_NAME} holds data the server does not accept.`;
  }
  const path = [DB_NAME, ...issue.path.map((key) => clip(String(key), QUOTE_MAX))].join(".");
  return `${FILE_NAME} holds data the server does not accept, at ${path}: ${issue.message}.`;
}
