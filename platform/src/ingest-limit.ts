import { type Bucket, level, type Limit, limit, waitSeconds } from "./token-bucket.js";

/** Most keys `UploadLimiter` keeps a bucket for. */
export const MAX_TRACKED_UPLOAD_KEYS = 10_000;

/** How often `UploadLimiter` drops the buckets that have refilled. */
const SWEEP_INTERVAL_MS = 60 * 1000;

export interface UploadLimit {
  /** Uploads a key may make at once. */
  burst: number;
  /** Uploads added to a key's bucket per minute. */
  ratePerMinute: number;
}

/**
 * The ingest rate limit (§8.3): a token bucket per key. `ingest.ts` keys it
 * by the upload's `(device, kit, source_id, instance)`. A bucket holds
 * `burst` uploads and refills at `ratePerMinute`; an upload takes one.
 *
 * Memory is bounded. A bucket that has refilled is the same as none, so the
 * full ones are dropped once per `SWEEP_INTERVAL_MS`, and whenever
 * `MAX_TRACKED_UPLOAD_KEYS` are kept. Past that most, the least recently used
 * key is dropped, and its next upload starts with a full bucket. The buckets
 * are in memory, per process; a restart clears them.
 *
 * After `RateLimiter` in `cloud/src/rateLimit.ts` of bttf/wow-guide@df80260,
 * with the bucket arithmetic of `token-bucket.ts`.
 */
export class UploadLimiter {
  readonly #limit: Limit;
  /** In order of last use, least recent first. */
  readonly #buckets = new Map<string, Bucket>();
  #sweptAt: number;

  constructor(
    settings: UploadLimit,
    private readonly now: () => number = Date.now,
  ) {
    this.#limit = limit(settings.burst, settings.ratePerMinute * 60);
    this.#sweptAt = now();
  }

  /** The buckets kept. */
  get tracked(): number {
    return this.#buckets.size;
  }

  /** Takes one upload of `key`: 0 when it is allowed, or else the whole seconds until one will be. */
  take(key: string): number {
    const now = this.now();
    const tokens = level(this.#limit, this.#buckets.get(key), now);
    const wait = waitSeconds(this.#limit, tokens);
    if (wait > 0) return wait;
    this.#keep(key, { tokens: tokens - 1, at: now }, now);
    return 0;
  }

  #keep(key: string, bucket: Bucket, now: number): void {
    this.#buckets.delete(key);
    if (now - this.#sweptAt >= SWEEP_INTERVAL_MS || this.#buckets.size >= MAX_TRACKED_UPLOAD_KEYS) {
      this.#sweptAt = now;
      for (const [other, kept] of this.#buckets) if (level(this.#limit, kept, now) >= this.#limit.burst) this.#buckets.delete(other);
    }
    if (this.#buckets.size >= MAX_TRACKED_UPLOAD_KEYS) {
      const oldest = this.#buckets.keys().next();
      if (oldest.done !== true) this.#buckets.delete(oldest.value);
    }
    this.#buckets.set(key, bucket);
  }
}
