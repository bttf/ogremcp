import { describe, expect, it } from "vitest";

import { MAX_TRACKED_UPLOAD_KEYS, UploadLimiter } from "./ingest-limit.js";

describe("UploadLimiter (§8.3)", () => {
  it("allows a burst, then one upload per interval, for each key on its own", () => {
    let now = 0;
    const limiter = new UploadLimiter({ burst: 2, ratePerMinute: 12 }, () => now);
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(5);
    expect(limiter.take("b")).toBe(0);
    now += 5_000;
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(5);
  });

  it("keeps a bounded number of keys, and drops the ones that have refilled", () => {
    let now = 0;
    const limiter = new UploadLimiter({ burst: 3, ratePerMinute: 12 }, () => now);
    for (let i = 0; i <= MAX_TRACKED_UPLOAD_KEYS; i++) limiter.take(`key-${i}`);
    expect(limiter.tracked).toBe(MAX_TRACKED_UPLOAD_KEYS);
    now += 60_000;
    limiter.take("new");
    expect(limiter.tracked).toBe(1);
  });
});
