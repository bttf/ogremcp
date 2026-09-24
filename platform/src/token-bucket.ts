/**
 * Token buckets for the rate limits of `oidc-registration.ts` and
 * `devices.ts`. A bucket holds at most `burst` requests and refills at its
 * rate per hour; a request takes one.
 */

const HOUR_MS = 60 * 60 * 1000;

export interface Limit {
  burst: number;
  /** Requests added per millisecond. */
  perMs: number;
}

export interface Bucket {
  tokens: number;
  /** When `tokens` was counted, in milliseconds. */
  at: number;
}

export function limit(burst: number, ratePerHour: number): Limit {
  return { burst, perMs: ratePerHour / HOUR_MS };
}

/** The requests `bucket` holds at `now`. A bucket not yet used is full. */
export function level({ burst, perMs }: Limit, bucket: Bucket | undefined, now: number): number {
  return bucket === undefined ? burst : Math.min(burst, bucket.tokens + (now - bucket.at) * perMs);
}

/** The seconds until a bucket at `tokens` holds one request: 0 when it does now. */
export function waitSeconds({ perMs }: Limit, tokens: number): number {
  return tokens >= 1 ? 0 : Math.ceil((1 - tokens) / perMs / 1000);
}
