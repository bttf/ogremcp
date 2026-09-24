// Structural types for the MCP shapes a kit tool uses (docs/architecture.md
// §10.5). They are subsets of the official MCP TypeScript SDK's types and
// assignable to them, so the SDK needs no dependency on it. They are type
// aliases, not interfaces, so that they fit the MCP types' index signatures.

export type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

/** A JSON Schema. Structural, so the SDK needs no JSON Schema library. */
export type JSONSchema = { [keyword: string]: JSONValue };

/** A tool's input schema. MCP requires an object schema at the top level. */
export type ToolInputSchema = {
  type: "object";
  properties?: { [name: string]: JSONSchema };
  required?: string[];
  [keyword: string]: JSONValue | undefined;
};

/**
 * Hints that clients use to decide when to ask the user for confirmation
 * (§10.5). `readOnlyHint: true` on every kit tool.
 */
export type ToolAnnotations = {
  readOnlyHint?: boolean;
  openWorldHint?: boolean;
};

export type TextContent = { type: "text"; text: string };

/**
 * A tool call's result (§10.5): `structuredContent` plus the same JSON as a
 * text block in `content`. User-facing conditions (paid-only, no snapshot
 * yet) set `isError: true` with a plain-language message.
 */
export type ToolResult = {
  content: TextContent[];
  structuredContent?: { [key: string]: unknown };
  isError?: boolean;
};
