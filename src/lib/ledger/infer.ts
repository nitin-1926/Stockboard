import { actionEvent, matchCorporateAction, unappliedActions } from "./corporate-actions";
import { EPS, liveEvents, replay } from "./lots";
import type {
  Anomaly,
  CorporateAction,
  Currency,
  ISODate,
  LedgerEvent,
  Snapshot,
  Supersession,
} from "./types";
import { addDays, effDate } from "./types";

/** Broker holdings can lag fills by up to this many trading days (T+1 credit). */
export const LAG_TRADING_DAYS = 2;

/** Was the event part of the position the broker reported at `takenAt`? */
export const includedAt = (e: LedgerEvent, takenAt: string) =>
  e.executedAt ? Date.parse(e.executedAt) <= Date.parse(takenAt) : effDate(e) <= takenAt.slice(0, 10);

/** Price that makes (ledgerCost + residual×p) / snapshotQty = snapshotAvg. */
export const residualBuyPrice = (ledgerCost: number, residual: number, snapshotQty: number, snapshotAvg: number) =>
  (snapshotQty * snapshotAvg - ledgerCost) / residual;

/** Start of the last `n` weekdays ending on `date`. ponytail: ignores exchange holidays. */
function tradingDaysBack(date: ISODate, n: number): ISODate {
  let d = date;
  for (let counted = 0; ; d = addDays(d, -1)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6 && ++counted === n) return d;
  }
}

export interface InferInput {
  /** Every ledger event for this (broker, instrument), superseded ones included. */
  events: LedgerEvent[];
  supersessions?: Supersession[];
  prev: Snapshot | null;
  curr: Snapshot;
  /** Close (or price_latest) on curr's date; prices an inferred sell. */
  priceForDate: number;
  currency: Currency;
  /** INR rate on curr's date (1 for INR), prefetched by the caller. */
  fxRateInr: number;
  /** corporate_actions rows for the instrument. */
  actions?: CorporateAction[];
}

export interface InferResult {
  /** Events to insert (on conflict on sourceRef: do nothing). */
  events: LedgerEvent[];
  anomalies: Anomaly[];
  /** curr.qty − ledger qty as of curr.takenAt. */
  residual: number;
  /** Recent fills explain the gap; the broker hasn't caught up. Write nothing. */
  pendingLag?: boolean;
  /** Needs owner review; nothing written. */
  unexplained?: string;
}

/**
 * Residual inference: the ledger replayed as of the snapshot (fills included
 * by execution time) is compared with the snapshot; only the unexplained
 * residual becomes an event, so a fill and an inference never double count.
 * Order: lag check → corporate action → residual buy/sell.
 */
export function inferFromSnapshot(input: InferInput): InferResult {
  const { prev, curr, currency, fxRateInr } = input;
  const id = curr.instrumentId;
  const events = liveEvents(input.events, input.supersessions).filter((e) => e.instrumentId === id);
  const asOf = events.filter((e) => includedAt(e, curr.takenAt));
  const pos = replay(asOf).positions[id] ?? { qty: 0, cost: 0 };
  const date = curr.takenAt.slice(0, 10);
  const residual = curr.qty - pos.qty;
  const out: InferResult = { events: [], anomalies: [], residual };
  if (Math.abs(residual) <= EPS) return { ...out, residual: 0 };

  // Lag: recent fills move the ledger the opposite way of the gap and cover it.
  const since = tradingDaysBack(date, LAG_TRADING_DAYS);
  const recentFills = asOf
    .filter((e) => e.source === "fill" && (e.type === "buy" || e.type === "sell") && e.date >= since)
    .reduce((s, e) => s + (e.type === "buy" ? e.qty : -e.qty), 0);
  if (Math.sign(recentFills) === -Math.sign(residual) && Math.abs(recentFills) >= Math.abs(residual) - EPS)
    return { ...out, pendingLag: true };

  const match = matchCorporateAction({
    ledgerQty: pos.qty,
    ledgerCost: pos.cost,
    snapshotQty: curr.qty,
    snapshotAvg: curr.avgPrice,
    diffDate: date,
    actions: unappliedActions(id, input.actions ?? [], events),
  });
  if (match.kind === "unexplained") return { ...out, unexplained: match.reason };

  let qty = residual;
  if (match.kind === "action") {
    out.events.push(
      actionEvent({ action: match.action, date, heldQty: pos.qty, currency, fxRateInr, source: "inferred", approximate: false }),
    );
    if (!match.costPreserved && match.remainder === 0)
      out.anomalies.push({
        kind: "cost_mismatch",
        instrumentId: id,
        message: `${match.action.kind} on ${match.action.exDate}: qty matches but broker cost changed`,
      });
    qty = match.remainder;
    if (qty === 0) return out;
  }

  const sourceRef = prev ? `inferred:${id}:${prev.runId}:${curr.runId}` : `opening:${id}:${curr.runId}`;
  const base = { id: sourceRef, sourceRef, instrumentId: id, date, executedAt: curr.takenAt, currency, fxRateInr, approximate: true };
  if (qty < 0) {
    out.events.push({ ...base, type: "sell", source: "inferred", qty: -qty, price: input.priceForDate });
    return out;
  }
  let price = residualBuyPrice(pos.cost, qty, curr.qty, curr.avgPrice);
  if (!(price > 0) || !Number.isFinite(price)) {
    out.anomalies.push({
      kind: "price_fallback",
      instrumentId: id,
      eventId: sourceRef,
      message: `implied buy price ${price} is not positive; used snapshot avg ${curr.avgPrice}`,
    });
    price = curr.avgPrice;
  }
  out.events.push({ ...base, type: prev ? "buy" : "opening", source: prev ? "inferred" : "opening", qty, price });
  return out;
}
