// Pure target lifecycle (U16). No I/O: safe to import from client components (the editor
// uses priceFromPct / validateLevel for its live preview).
//
// Prices are RAW (prices_daily, docs/adr/0005): a target set before a split keeps its
// set-time price, and each bar after a split is compared against price ÷ the cumulative
// split ratio between the set date and that bar. best_price is reported back on the
// set-time basis so it compares directly with the stored price.
import { daysBetween } from "@/lib/returns/xirr";
import type { ISODate } from "@/lib/returns/types";

export type TargetKind = "target" | "stop";
export type TargetStatus = "pending" | "hit" | "stopped" | "expired" | "cancelled";

export interface EvalTarget {
  kind: TargetKind;
  /** Absolute, raw basis on the set date. */
  price: number;
  /** Market-local date it was set; only bars strictly after it count (the set day's range predates it). */
  setOn: ISODate;
  deadline: ISODate | null;
  status: TargetStatus;
  resolvedAt?: ISODate | null;
  resolvedPrice?: number | null;
  bestPrice?: number | null;
  missPct?: number | null;
}

/** One raw daily bar. high/low are null when the source only had a close. */
export interface Bar {
  date: ISODate;
  high: number | null;
  low: number | null;
  close: number;
}

/** Share-count multiplier on its ex-date (2:1 split → 2). Bonuses count too: the price drops the same way. */
export interface Split {
  exDate: ISODate;
  ratio: number;
}

export interface Evaluation {
  status: TargetStatus;
  resolvedAt: ISODate | null;
  /** Raw price on the resolving day: the high (target) / low (stop) that crossed, or the last close by the deadline. */
  resolvedPrice: number | null;
  /** Set-time basis. */
  bestPrice: number | null;
  missPct: number | null;
}

/**
 * Product of the ratios with ex-date in (date, upTo]: a raw price on `date` ÷ this = the price on
 * `upTo`'s basis (today's when `upTo` is omitted). The ex-date's own price is already post-split.
 */
export const factorAfter = (date: ISODate, splits: Split[], upTo?: ISODate) =>
  splits.reduce((f, s) => (s.exDate > date && (upTo == null || s.exDate <= upTo) ? f * s.ratio : f), 1);

const unchanged = (t: EvalTarget): Evaluation => ({
  status: t.status,
  resolvedAt: t.resolvedAt ?? null,
  resolvedPrice: t.resolvedPrice ?? null,
  bestPrice: t.bestPrice ?? null,
  missPct: t.missPct ?? null,
});

/**
 * Target + raw daily bars + corporate actions → status as of `asOf` (market-local date).
 * A target is hit when a day's high ≥ price (close when high is missing); a stop when a
 * day's low ≤ price. A hit on the deadline day beats expiry. Once `asOf` is past the
 * deadline with no hit, it expires with miss_pct = (best − price) / price. Resolved and
 * cancelled targets come back unchanged (immutable).
 */
export function evaluate(t: EvalTarget, bars: Bar[], splits: Split[], asOf: ISODate): Evaluation {
  if (t.status !== "pending") return unchanged(t);
  const last = t.deadline && t.deadline < asOf ? t.deadline : asOf;
  const window = bars.filter((b) => b.date > t.setOn && b.date <= last).sort((a, b) => a.date.localeCompare(b.date));
  const isTarget = t.kind === "target";

  let best: number | null = null;
  for (const b of window) {
    const factor = factorAfter(t.setOn, splits, b.date);
    const px = (isTarget ? b.high : b.low) ?? b.close;
    const onSetBasis = px * factor;
    best = best == null ? onSetBasis : isTarget ? Math.max(best, onSetBasis) : Math.min(best, onSetBasis);
    if (isTarget ? px >= t.price / factor : px <= t.price / factor)
      return { status: isTarget ? "hit" : "stopped", resolvedAt: b.date, resolvedPrice: px, bestPrice: best, missPct: null };
  }

  if (t.deadline && asOf > t.deadline)
    return {
      status: "expired",
      resolvedAt: t.deadline,
      resolvedPrice: window.at(-1)?.close ?? null,
      bestPrice: best,
      missPct: best == null ? null : (best - t.price) / t.price,
    };
  return { status: "pending", resolvedAt: null, resolvedPrice: null, bestPrice: best, missPct: null };
}

/** Calendar days from set to resolution (days-to-hit); null while pending. */
export const daysToResolve = (setOn: ISODate, resolvedAt: ISODate | null) =>
  resolvedAt ? Math.max(0, daysBetween(setOn, resolvedAt)) : null;

/** Distance from the current price to a level: 0.12 = the price must rise 12%. Negative for a level below. */
export const upside = (price: number, ltp: number | null | undefined) => (ltp != null && ltp > 0 ? price / ltp - 1 : null);

/** % mode → absolute: +20% (0.2) at 1000 → 1200, rounded to paise/cents. */
export const priceFromPct = (priceAtSet: number, pct: number) => Math.round(priceAtSet * (1 + pct) * 100) / 100;

/** A target must be above the current price and a stop below it (else it would resolve at once). */
export function validateLevel(kind: TargetKind, price: number, current: number): string | null {
  if (!(Number.isFinite(price) && price > 0)) return "Enter a price above zero.";
  if (kind === "target" && price <= current) return "A target must be above the current price.";
  if (kind === "stop" && price >= current) return "A stop must be below the current price.";
  return null;
}
