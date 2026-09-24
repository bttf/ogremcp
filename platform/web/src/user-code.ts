/**
 * A bridge's user code, as oidc-provider makes it (`platform/src/devices.ts`):
 * eight letters of `USER_CODE_ALPHABET`, shown as `BCDF-GHJK`. The service
 * reads a code whatever its case, spaces, and hyphens; the Device approval
 * page checks its form first, so a mistyped code gets a plain answer without
 * a round trip.
 *
 * Adapted from `cloud/src/pairing.ts` in bttf/wow-guide@df80260.
 */

/**
 * The letters of a user code: oidc-provider's `base-20`, the consonants of
 * RFC 8628, section 6.1. No vowel, so no word is spelt, and no digit, so none
 * is read as a letter. 20 letters in 8 places is about 34 bits.
 */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const USER_CODE_LENGTH = 8;

/**
 * A user code as typed, in the form the service stores: upper case, with
 * spaces and hyphens dropped. Null when it is not eight letters of the
 * alphabet.
 */
export function normalizeUserCode(input: string): string | null {
  if (input.length > 32) return null;
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== USER_CODE_LENGTH) return null;
  for (const letter of code) if (!USER_CODE_ALPHABET.includes(letter)) return null;
  return code;
}
