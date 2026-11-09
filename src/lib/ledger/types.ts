/**
 * Ledger (U11) types. Pure: no I/O. The DB layer (schema/ledger.ts, ingest.ts)
 * persists these shapes and calls the functions in this folder.
 * Conventions follow src/lib/returns/types.ts: float64 numbers, ISO dates.
 */
import type { Currency, ISODate, Lot } from "@/lib/returns/types";

export type { Currency, ISODate };

export type EventType = "buy" | "sell" | "split" | "bonus" | "dividend" | "opening";
export type EventSource = "fill" | "csv" | "inferred" | "manual" | "opening" | "us_history";

/**
 * Quantity factor post/pre: a 2:1 split is {num: 2, den: 1}. A 1:1 bonus is
 * also {2, 1}, which is how Yahoo reports it, so reclassifying a split as a
 * bonus only flips `type`.
 */
export interface Ratio {
  num: number;
  den: number;
}

export interface LedgerEvent {
  id: string;
  instrumentId: string;
  type: EventType;
  /** Trade date; for a bonus, the allotment (credit) date. */
  date: ISODate;
  /** ISO timestamp with offset, when known (fills, CSV, inferred = snapshot time). */
  executedAt?: string;
  /** Shares. Informational for split/bonus: replay derives them from `ratio`. */
  qty: number;
  /** Per share, native currency. 0 for split/bonus. */
  price: number;
  currency: Currency;
  /** INR per unit of `currency` on `date` (1 for INR). Never null. */
  fxRateInr: number;
  source: EventSource;
  /** Unique and deterministic, so re-ingesting is a no-op. */
  sourceRef: string;
  approximate: boolean;
  ratio?: Ratio;
  /**
   * Split/bonus only: ex-date. Replay applies the action here, so trades after
   * the ex-date stay on the post-split basis while a bonus lot keeps `date`.
   */
  exDate?: ISODate;
}

export interface Snapshot {
  runId: string;
  /** ISO with the market's offset (e.g. +05:30), so slice(0, 10) is the local date. */
  takenAt: string;
  broker: string;
  instrumentId: string;
  qty: number;
  avgPrice: number;
}

export interface Supersession {
  supersededId: string;
  supersedingId: string;
}

/** A row of `corporate_actions` (Yahoo split events; kind defaults to split). */
export interface CorporateAction {
  instrumentId: string;
  exDate: ISODate;
  ratio: Ratio;
  kind: "split" | "bonus";
}

export type AnomalyKind =
  | "oversell"
  | "price_fallback"
  | "cost_mismatch"
  | "unexplained"
  | "unexplained_opening"
  | "exceeds_broker";

export interface Anomaly {
  kind: AnomalyKind;
  instrumentId: string;
  eventId?: string;
  message: string;
}

/** A returns-engine Lot tagged with the event that opened it (for bucket membership). */
export interface LedgerLot extends Lot {
  eventId: string;
}

export const factor = (r: Ratio) => r.num / r.den;

/** Date the event takes effect in replay: split/bonus at the ex-date. */
export const effDate = (e: LedgerEvent) => e.exDate ?? e.date;

const DAY = 86_400_000;
// Same as market/fx.ts addDays, which can't be imported here (it pulls in the DB client).
export const addDays = (d: ISODate, n: number): ISODate =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
