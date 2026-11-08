import { describe, expect, it } from "vitest";
import { capBucket, DEFAULT_CAP_THRESHOLDS, parseCapThresholds } from "./market-cap";

describe("capBucket", () => {
  it("India: ₹20,000 cr and up is large, ₹5,000 cr mid, below small", () => {
    expect(capBucket("IN", 20_000e7)).toBe("large");
    expect(capBucket("IN", 19_999e7)).toBe("mid");
    expect(capBucket("IN", 5_000e7)).toBe("mid");
    expect(capBucket("IN", 4_999e7)).toBe("small");
  });

  it("US: $10B large, $2B mid, below small", () => {
    expect(capBucket("US", 3e12)).toBe("large");
    expect(capBucket("US", 10e9)).toBe("large");
    expect(capBucket("US", 5e9)).toBe("mid");
    expect(capBucket("US", 1.9e9)).toBe("small");
  });

  it("missing or bad cap → unknown", () => {
    expect(capBucket("IN", null)).toBe("unknown");
    expect(capBucket("US", undefined)).toBe("unknown");
    expect(capBucket("US", 0)).toBe("unknown");
    expect(capBucket("US", Number.NaN)).toBe("unknown");
  });

  it("uses the thresholds passed in", () => {
    const t = { ...DEFAULT_CAP_THRESHOLDS, IN: { large: 1e12, mid: 1e11 } };
    expect(capBucket("IN", 5e11, t)).toBe("mid");
  });
});

describe("parseCapThresholds", () => {
  it("keeps a valid market and defaults a malformed one", () => {
    const t = parseCapThresholds({ IN: { large: 3e11, mid: 6e10 }, US: { large: 1, mid: 5 } });
    expect(t.IN).toEqual({ large: 3e11, mid: 6e10 });
    expect(t.US).toEqual(DEFAULT_CAP_THRESHOLDS.US);
    expect(parseCapThresholds(null)).toEqual(DEFAULT_CAP_THRESHOLDS);
  });
});
