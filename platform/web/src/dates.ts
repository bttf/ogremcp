/**
 * An instant in the reader's time zone, to the minute. Adapted from `when`
 * in `web/src/pages/Account.tsx` in bttf/wow-guide@df80260.
 */
export function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The day of an instant, in the reader's time zone. */
export function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}
