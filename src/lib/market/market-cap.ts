// Market-cap buckets (U19). India approximates SEBI's rank-based large/mid/small
// (top 100 / 101-250 / rest) with absolute ₹ thresholds; US uses the common USD cut-offs.
// Thresholds live in `settings.market_cap_thresholds` (owner-editable, native currency units).
import type { Market } from "@/lib/returns/types";

export type CapBucket = "large" | "mid" | "small" | "unknown";
/** Native currency: rupees for IN, dollars for US. A cap ≥ `large` is large, ≥ `mid` is mid, else small. */
export type CapThresholds = Record<Market, { large: number; mid: number }>;

const CRORE = 1e7;
export const DEFAULT_CAP_THRESHOLDS: CapThresholds = {
  IN: { large: 20_000 * CRORE, mid: 5_000 * CRORE },
  US: { large: 10e9, mid: 2e9 },
};

export const CAP_LABEL: Record<CapBucket, string> = {
  large: "Large cap",
  mid: "Mid cap",
  small: "Small cap",
  unknown: "Unknown",
};

export function capBucket(market: Market, marketCap: number | null | undefined, t: CapThresholds = DEFAULT_CAP_THRESHOLDS): CapBucket {
  if (marketCap == null || !Number.isFinite(marketCap) || marketCap <= 0) return "unknown";
  const { large, mid } = t[market];
  return marketCap >= large ? "large" : marketCap >= mid ? "mid" : "small";
}

const okPair = (v: unknown): v is { large: number; mid: number } => {
  if (!v || typeof v !== "object") return false;
  const { large, mid } = v as Record<string, unknown>;
  return typeof large === "number" && typeof mid === "number" && mid > 0 && large > mid;
};

/** A stored settings value → thresholds; anything malformed falls back to the default per market. */
export function parseCapThresholds(value: unknown): CapThresholds {
  const v = (value ?? {}) as Record<string, unknown>;
  return {
    IN: okPair(v.IN) ? { large: v.IN.large, mid: v.IN.mid } : DEFAULT_CAP_THRESHOLDS.IN,
    US: okPair(v.US) ? { large: v.US.large, mid: v.US.mid } : DEFAULT_CAP_THRESHOLDS.US,
  };
}
