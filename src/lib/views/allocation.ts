// Server-only view module (U19). getAllocationView() resolves the actor, reuses the
// holdings loader and builder (so weights match the Holdings page exactly), joins
// instrument metadata, and hands it to the pure buildAllocationView().
//
// Redaction: the builder only ever sees weights (percentages), never values, so a
// hide-amounts actor gets the same view. Weights aren't amounts (R4).
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { instruments } from "@/db/schema";
import { type Actor, can, requireActor } from "@/lib/auth/access";
import { CAP_LABEL, type CapBucket, type CapThresholds, capBucket } from "@/lib/market/market-cap";
import type { Market } from "@/lib/returns/types";
import { loadPreferences } from "@/lib/settings/preferences";
import { buildHoldingsView, loadHoldingsInputs } from "./holdings";

export interface AllocationHolding {
  instrumentId: string;
  symbol: string;
  name: string;
  market: Market;
  /** Share of the combined INR value of priced holdings; null when unpriced. */
  weightPct: number | null;
  sector: string | null;
  marketCap: number | null;
}

export interface AllocationInputs {
  holdings: AllocationHolding[];
  /** Percent limits (20 = 20%) and cap thresholds, from settings. */
  limits: { stockPct: number; sectorPct: number; capThresholds: CapThresholds };
}

export interface Group {
  key: string;
  label: string;
  weightPct: number;
  count: number;
  symbols: string[];
}

export interface ConcentrationWarning {
  kind: "stock" | "sector";
  key: string;
  label: string;
  weightPct: number;
  /** Fraction. */
  limitPct: number;
}

export interface AllocationView {
  empty: boolean;
  amountsHidden: boolean;
  byMarket: Group[];
  bySector: Group[];
  byCap: Group[];
  /** One group per holding; key is the instrument id. */
  byStock: Group[];
  warnings: ConcentrationWarning[];
  /** Holdings with no sector: the owner can set one inline or run enrichment. */
  unclassified: { instrumentId: string; symbol: string; name: string; weightPct: number | null }[];
  /** Holdings without a price: left out of every weight. */
  unpriced: number;
  limits: { stockPct: number; sectorPct: number };
  /** Sector names already in use (suggestions for the override). */
  sectors: string[];
  canManage: boolean;
}

export const UNCLASSIFIED = "Unclassified";
const MARKET_LABEL: Record<Market, string> = { IN: "India", US: "US" };
const CAP_ORDER: CapBucket[] = ["large", "mid", "small", "unknown"];

function groupBy(rows: AllocationHolding[], keyOf: (h: AllocationHolding) => string, labelOf: (k: string) => string): Group[] {
  const m = new Map<string, Group>();
  for (const h of rows) {
    const k = keyOf(h);
    const g = m.get(k) ?? { key: k, label: labelOf(k), weightPct: 0, count: 0, symbols: [] };
    g.weightPct += h.weightPct!;
    g.count++;
    g.symbols.push(h.symbol);
    m.set(k, g);
  }
  return [...m.values()];
}

const byWeight = (a: Group, b: Group) => b.weightPct - a.weightPct || a.label.localeCompare(b.label);

/** Pure: weights → breakdowns and concentration warnings. Same output for every actor except the flags. */
export function buildAllocationView(inputs: AllocationInputs, actor: Actor): AllocationView {
  const priced = inputs.holdings.filter((h) => h.weightPct != null && h.weightPct > 0);
  const stockLimit = inputs.limits.stockPct / 100;
  const sectorLimit = inputs.limits.sectorPct / 100;
  const sectorOf = (h: AllocationHolding) => h.sector?.trim() || UNCLASSIFIED;

  const byMarket = groupBy(priced, (h) => h.market, (k) => MARKET_LABEL[k as Market]).sort((a, b) => a.key.localeCompare(b.key));
  // Unclassified always last: it isn't a sector, so it shouldn't rank among them.
  const bySector = groupBy(priced, sectorOf, (k) => k).sort((a, b) =>
    a.key === UNCLASSIFIED ? 1 : b.key === UNCLASSIFIED ? -1 : byWeight(a, b),
  );
  const byCap = groupBy(
    priced,
    (h) => capBucket(h.market, h.marketCap, inputs.limits.capThresholds),
    (k) => CAP_LABEL[k as CapBucket],
  ).sort((a, b) => CAP_ORDER.indexOf(a.key as CapBucket) - CAP_ORDER.indexOf(b.key as CapBucket));
  const byStock = priced
    .map((h) => ({ key: h.instrumentId, label: h.symbol, weightPct: h.weightPct!, count: 1, symbols: [h.symbol] }))
    .sort(byWeight);

  const warnings: ConcentrationWarning[] = [
    ...byStock
      .filter((g) => g.weightPct > stockLimit)
      .map((g) => ({ kind: "stock" as const, key: g.key, label: g.label, weightPct: g.weightPct, limitPct: stockLimit })),
    ...bySector
      .filter((g) => g.key !== UNCLASSIFIED && g.weightPct > sectorLimit)
      .map((g) => ({ kind: "sector" as const, key: g.key, label: g.label, weightPct: g.weightPct, limitPct: sectorLimit })),
  ].sort((a, b) => b.weightPct - a.weightPct);

  return {
    empty: inputs.holdings.length === 0,
    amountsHidden: actor.hideAmounts,
    byMarket,
    bySector,
    byCap,
    byStock,
    warnings,
    unclassified: inputs.holdings
      .filter((h) => !h.sector?.trim())
      .map((h) => ({ instrumentId: h.instrumentId, symbol: h.symbol, name: h.name, weightPct: h.weightPct }))
      .sort((a, b) => (b.weightPct ?? -1) - (a.weightPct ?? -1)),
    unpriced: inputs.holdings.length - inputs.holdings.filter((h) => h.weightPct != null).length,
    limits: { stockPct: stockLimit, sectorPct: sectorLimit },
    sectors: [...new Set(inputs.holdings.flatMap((h) => (h.sector?.trim() ? [h.sector.trim()] : [])))].sort(),
    canManage: can(actor, "manage"),
  };
}

export async function getAllocationView(): Promise<AllocationView> {
  const actor = await requireActor();
  const [hv, prefs] = await Promise.all([loadHoldingsInputs(new Date()).then((i) => buildHoldingsView(i, actor)), loadPreferences()]);
  const ids = hv.rows.map((r) => r.instrumentId);
  const meta = ids.length
    ? await db
        .select({ id: instruments.id, sector: instruments.sector, marketCap: instruments.marketCap })
        .from(instruments)
        .where(inArray(instruments.id, ids))
    : [];
  const byId = new Map(meta.map((m) => [m.id, m]));
  return buildAllocationView(
    {
      limits: { stockPct: prefs.stockPct, sectorPct: prefs.sectorPct, capThresholds: prefs.capThresholds },
      holdings: hv.rows.map((r) => {
        const m = byId.get(r.instrumentId);
        return {
          instrumentId: r.instrumentId,
          symbol: r.symbol,
          name: r.name,
          market: r.market,
          weightPct: r.weightPct,
          sector: m?.sector ?? null,
          marketCap: m?.marketCap == null ? null : Number(m.marketCap),
        };
      }),
    },
    actor,
  );
}
