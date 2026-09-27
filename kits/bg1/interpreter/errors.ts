// User-facing ParseError messages (docs/architecture.md §6.2, §8.3). The
// bridge shows them to the player, so every message is clipped to
// MESSAGE_MAX characters, and text quoted from the upload to QUOTE_MAX.
import { ParseError, type ParseErrorFacts } from "@ogremcp/sdk";

export const MESSAGE_MAX = 300;
export const QUOTE_MAX = 40;

/** `text`, cut to at most `max` characters with an ellipsis when it is longer. */
export function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  let end = max - 1;
  // Never split a surrogate pair.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end--;
  }
  return `${text.slice(0, end)}…`;
}

/** A ParseError with `message`, clipped, and the facts read before the failure (§16.1). */
export function parseError(message: string, facts: ParseErrorFacts = {}): ParseError {
  return new ParseError(clip(message, MESSAGE_MAX), facts);
}
