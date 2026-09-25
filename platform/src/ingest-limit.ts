import { type Bucket, level, type Limit, limit, waitSeconds } from "./token-bucket.js";

/** Most keys `UploadLimiter` keeps a bucket for, in each of its two maps. */
export const MAX_TRACKED_UPLOAD_KEYS = 10_000;

/** How often `UploadLimiter` drops the buckets that have refilled. */
const SWEEP_INTERVAL_MS = 60 * 1000;

export interface UploadLimit {
  /** Uploads of one source instance of one device, at once. */
  burst: number;
  /** Uploads added per minute to the bucket of one source instance of one device. */
  ratePerMinute: number;
  /** Uploads of one device, all its instances together, at once. */
  deviceBurst: number;
  /** Uploads added per minute to the bucket of one device. */
  deviceRatePerMinute: number;
}

/**
 * The ingest rate limit (§8.3): token buckets, one per source instance of a
 * device and one per device. `ingest.ts` keys the first by the upload's
 * `(device, kit, source_id, instance)` and the second by the device. An
 * upload takes one from both, or is refused while either is empty; a refused
 * upload takes nothing. `instance` is the client's to choose, so the looser
 * device bucket is what limits a device that sends a new one each time.
 *
 * Memory is bounded. A bucket that has refilled is the same as none, so the
 * full ones are dropped once per `SWEEP_INTERVAL_MS`, and from a map that
 * holds `MAX_TRACKED_UPLOAD_KEYS`. Past that most, the map's least recently
 * used key is dropped, and its next upload starts with a full bucket. The
 * buckets are in memory, per process; a restart clears them.
 *
 * After `RateLimiter` in `cloud/src/rateLimit.ts` of bttf/wow-guide@df80260,
 * with the bucket arithmetic of `token-bucket.ts`.
 */
export class UploadLimiter {
  readonly #instance: Limit;
  readonly #device: Limit;
  /** In order of last use, least recent first. */
  readonly #instances = new Map<string, Bucket>();
  /** In order of last use, least recent first. */
  readonly #devices = new Map<string, Bucket>();
  #sweptAt: number;

  constructor(
    settings: UploadLimit,
    private readonly now: () => number = Date.now,
  ) {
    this.#instance = limit(settings.burst, settings.ratePerMinute * 60);
    this.#device = limit(settings.deviceBurst, settings.deviceRatePerMinute * 60);
    this.#sweptAt = now();
  }

  /** The buckets kept, of instances and of devices together. */
  get tracked(): number {
    return this.#instances.size + this.#devices.size;
  }

  /**
   * Takes one upload of `instance` of `device`: 0 when it is allowed, or else
   * the whole seconds until one will be.
   */
  take(device: string, instance: string): number {
    const now = this.now();
    const own = level(this.#instance, this.#instances.get(instance), now);
    const all = level(this.#device, this.#devices.get(device), now);
    const wait = Math.max(waitSeconds(this.#instance, own), waitSeconds(this.#device, all));
    if (wait > 0) return wait;
    const sweep = now - this.#sweptAt >= SWEEP_INTERVAL_MS;
    if (sweep) this.#sweptAt = now;
    keep(this.#instances, this.#instance, instance, { tokens: own - 1, at: now }, sweep);
    keep(this.#devices, this.#device, device, { tokens: all - 1, at: now }, sweep);
    return 0;
  }
}

/**
 * Sets `key`'s bucket as the most recently used. With `sweep`, or when the
 * map is full, it first drops the buckets that have refilled; then, when the
 * map is still full, the least recently used one.
 */
function keep(buckets: Map<string, Bucket>, bucketLimit: Limit, key: string, bucket: Bucket, sweep: boolean): void {
  buckets.delete(key);
  if (sweep || buckets.size >= MAX_TRACKED_UPLOAD_KEYS) {
    for (const [other, kept] of buckets) if (level(bucketLimit, kept, bucket.at) >= bucketLimit.burst) buckets.delete(other);
  }
  if (buckets.size >= MAX_TRACKED_UPLOAD_KEYS) {
    const oldest = buckets.keys().next();
    if (oldest.done !== true) buckets.delete(oldest.value);
  }
  buckets.set(key, bucket);
}
