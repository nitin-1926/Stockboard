// Owner preferences in the `settings` key/value table (U19). Each key holds one jsonb
// value; a missing or malformed value falls back to its default, so no migration is
// needed and a bad write can't break a page. Written only by /settings/preferences.
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { type CapThresholds, DEFAULT_CAP_THRESHOLDS, parseCapThresholds } from "@/lib/market/market-cap";

export const PREF_KEYS = {
  stockPct: "concentration_stock_pct",
  sectorPct: "concentration_sector_pct",
  capThresholds: "market_cap_thresholds",
  indiaTds: "india_dividend_tds",
} as const;

export interface Preferences {
  /** Single-stock concentration limit, percent (20 = 20%). */
  stockPct: number;
  /** Sector concentration limit, percent. */
  sectorPct: number;
  capThresholds: CapThresholds;
  /** India dividend TDS as a fraction (0.1 = 10%); read by buckets/benchmark via `dividendWithholding()`. */
  indiaTds: number;
}

export const DEFAULT_PREFERENCES: Preferences = {
  stockPct: 20,
  sectorPct: 35,
  capThresholds: DEFAULT_CAP_THRESHOLDS,
  indiaTds: 0.1,
};

const pct = (v: unknown, d: number) => (typeof v === "number" && v > 0 && v <= 100 ? v : d);

/** Pure: stored values by key → preferences with defaults. */
export function parsePreferences(values: Record<string, unknown>): Preferences {
  const tds = values[PREF_KEYS.indiaTds];
  return {
    stockPct: pct(values[PREF_KEYS.stockPct], DEFAULT_PREFERENCES.stockPct),
    sectorPct: pct(values[PREF_KEYS.sectorPct], DEFAULT_PREFERENCES.sectorPct),
    capThresholds: parseCapThresholds(values[PREF_KEYS.capThresholds]),
    // Same rule as dividendWithholding() in views/buckets.ts.
    indiaTds: typeof tds === "number" && tds >= 0 && tds < 1 ? tds : DEFAULT_PREFERENCES.indiaTds,
  };
}

export async function loadPreferences(): Promise<Preferences> {
  const rows = await db.select().from(settings).where(inArray(settings.key, Object.values(PREF_KEYS)));
  return parsePreferences(Object.fromEntries(rows.map((r) => [r.key, r.value])));
}
