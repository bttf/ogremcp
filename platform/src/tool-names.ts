// The rules for MCP tool names and the per-kit tool budget
// (docs/architecture.md §10.1, §10.2). `checkKits` applies them to kit tools
// and `createToolRegistry` to platform tools, at startup, so a bad name stops
// the start. Each rule applies to the full name: a `tool_prefix` may be 60
// characters, so a name built on it can still pass 64.
import { checkToolName } from "@ogremcp/sdk";

/** §10.2: at most 8 tools per kit. */
export const MAX_KIT_TOOLS = 8;

const MAX_TOOL_NAME_LENGTH = 64;

/** `{verb}_{noun}`: two or more lowercase snake_case words, `[a-z0-9_]` only. */
const VERB_NOUN = /^[a-z0-9]+(_[a-z0-9]+)+$/;

/** ChatGPT expects tools with these names to have its deep-research schema (§10.1). */
const RESERVED = new Set(["search", "fetch"]);

/**
 * Why a kit tool's name breaks §10.1, or null: it must be
 * `{toolPrefix}_{verb}_{noun}`, lowercase snake_case, at most 64 characters.
 */
export function checkKitToolName(name: string, toolPrefix: string): string | null {
  // The prefix, the length, and snake_case.
  const problem = checkToolName(name, toolPrefix);
  if (problem !== null) return problem;
  if (!VERB_NOUN.test(name.slice(toolPrefix.length + 1))) {
    return `Tool name "${name}" must be ${toolPrefix}_{verb}_{noun}: a verb and a noun after the prefix.`;
  }
  return null;
}

/**
 * Why a platform tool's name breaks §10.1, or null: it must be
 * `{verb}_{noun}` with no prefix, lowercase snake_case, at most 64
 * characters, and not `search` or `fetch`.
 */
export function checkPlatformToolName(name: string): string | null {
  if (RESERVED.has(name)) {
    return `Tool name "${name}" is reserved: ChatGPT expects a tool named "${name}" to have its deep-research schema.`;
  }
  if (name.length > MAX_TOOL_NAME_LENGTH) {
    return `Tool name "${name}" is longer than ${MAX_TOOL_NAME_LENGTH} characters.`;
  }
  if (!VERB_NOUN.test(name)) {
    return `Tool name "${name}" must be {verb}_{noun} in lowercase snake_case: [a-z0-9_] only, with no leading, trailing, or doubled "_".`;
  }
  return null;
}
