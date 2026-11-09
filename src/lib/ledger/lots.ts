import { sellFifo } from "@/lib/returns/pnl";
import type { Lot } from "@/lib/returns/types";
import type { Anomaly, EventType, LedgerEvent, LedgerLot, Supersession } from "./types";
import { effDate, factor } from "./types";

export const EPS = 1e-9;

export const openQty = (l: Lot) => l.qty - l.closed.reduce((s, c) => s + c.qty, 0);

export function liveEvents(events: LedgerEvent[], supersessions: Supersession[] = []) {
  const gone = new Set(supersessions.map((s) => s.supersededId));
  return events.filter((e) => !gone.has(e.id));
}

// Same day: corporate actions first (trades on the ex-date are post-split), then buys, then sells.
const RANK: Record<EventType, number> = { split: 0, bonus: 0, opening: 1, buy: 1, sell: 2, dividend: 3 };
const byReplayOrder = (a: LedgerEvent, b: LedgerEvent) =>
  effDate(a).localeCompare(effDate(b)) ||
  RANK[a.type] - RANK[b.type] ||
  (a.executedAt ?? "").localeCompare(b.executedAt ?? "");

function ratioOf(e: LedgerEvent) {
  if (!e.ratio) throw new Error(`${e.type} event ${e.id} has no ratio`);
  return factor(e.ratio);
}

const newLot = (e: LedgerEvent, qty: number, cost: number): LedgerLot => ({
  eventId: e.id,
  instrumentId: e.instrumentId,
  market: e.currency === "USD" ? "US" : "IN",
  currency: e.currency,
  qty,
  costPerShare: cost,
  openDate: e.date,
  fxRateAtOpen: e.fxRateInr,
  closed: [],
});

/** Broker-convention position: weighted-average cost basis (sells don't change avg). */
export interface Position {
  qty: number;
  cost: number;
}

export interface ReplayResult {
  /** Lots with open quantity, oldest first. Partly sold lots keep their closed portions. */
  openLots: LedgerLot[];
  closedLots: LedgerLot[];
  realized: Record<string, { native: number; inr: number }>;
  positions: Record<string, Position>;
  anomalies: Anomaly[];
}

/**
 * Pure FIFO replay of the ledger. Superseded events and dividends are skipped
 * (dividends are the returns engine's job). Split: open lots ×f qty, ÷f price,
 * date kept. Bonus: a zero-cost lot of held×(f−1), counted at the ex-date but
 * dated at allotment (`date`). Oversells are clamped and flagged.
 */
export function replay(events: LedgerEvent[], supersessions: Supersession[] = []): ReplayResult {
  const lots: Record<string, LedgerLot[]> = {};
  const positions: Record<string, Position> = {};
  const anomalies: Anomaly[] = [];

  for (const e of liveEvents(events, supersessions).sort(byReplayOrder)) {
    if (e.type === "dividend") continue;
    const id = e.instrumentId;
    const held = (lots[id] ??= []);
    const pos = (positions[id] ??= { qty: 0, cost: 0 });

    if (e.type === "buy" || e.type === "opening") {
      held.push(newLot(e, e.qty, e.price));
      pos.qty += e.qty;
      pos.cost += e.qty * e.price;
    } else if (e.type === "split") {
      const f = ratioOf(e);
      lots[id] = held.map((l) =>
        openQty(l) > EPS
          ? {
              ...l,
              qty: l.qty * f,
              costPerShare: l.costPerShare / f,
              closed: l.closed.map((c) => ({ ...c, qty: c.qty * f, pricePerShare: c.pricePerShare / f })),
            }
          : l,
      );
      pos.qty *= f;
    } else if (e.type === "bonus") {
      const q = pos.qty * (ratioOf(e) - 1);
      if (q > EPS) held.push(newLot(e, q, 0));
      pos.qty += q;
    } else {
      const available = held.reduce((s, l) => s + openQty(l), 0);
      const q = Math.min(e.qty, available);
      if (e.qty - q > EPS)
        anomalies.push({
          kind: "oversell",
          instrumentId: id,
          eventId: e.id,
          message: `sell of ${e.qty} on ${e.date} exceeds open ${available}; clamped`,
        });
      if (q <= EPS) continue;
      lots[id] = sellFifo(held, { qty: q, date: e.date, pricePerShare: e.price, fxRate: e.fxRateInr }) as LedgerLot[];
      pos.cost -= (pos.cost / pos.qty) * q;
      pos.qty -= q;
    }
  }

  const all = Object.values(lots)
    .flat()
    .sort((a, b) => a.openDate.localeCompare(b.openDate));
  const realized: ReplayResult["realized"] = {};
  for (const id of Object.keys(positions)) realized[id] = { native: 0, inr: 0 };
  for (const l of all)
    for (const c of l.closed) {
      realized[l.instrumentId].native += c.qty * (c.pricePerShare - l.costPerShare);
      realized[l.instrumentId].inr += c.qty * (c.pricePerShare * c.fxRate - l.costPerShare * l.fxRateAtOpen);
    }

  return {
    openLots: all.filter((l) => openQty(l) > EPS),
    closedLots: all.filter((l) => openQty(l) <= EPS),
    realized,
    positions,
    anomalies,
  };
}
