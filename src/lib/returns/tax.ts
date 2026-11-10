import type { ISODate, Market } from "./types";

/**
 * Listed Indian equity is long-term after more than 12 months; foreign shares
 * held by a resident after more than 24 months (Budget 2024). "More than N
 * months" → eligible the day after the N-month anniversary. A bonus lot is its
 * own Lot dated at allotment, so it gets its own clock.
 */
const HOLDING_MONTHS: Record<Market, number> = { IN: 12, US: 24 };

export function ltcgEligibleDate(openDate: ISODate, market: Market): ISODate {
  const [y, m, d] = openDate.split("-").map(Number);
  const months = m - 1 + HOLDING_MONTHS[market];
  const ty = y + Math.floor(months / 12);
  const tm = months % 12;
  // Clamp to month end (Feb 29 + 12 months → Feb 28), then +1 day.
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ty, tm, Math.min(d, lastDay) + 1)).toISOString().slice(0, 10);
}

export const isLongTerm = (openDate: ISODate, market: Market, asOf: ISODate): boolean =>
  asOf >= ltcgEligibleDate(openDate, market);
