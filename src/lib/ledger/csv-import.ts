import { actionEvent } from "./corporate-actions";
import { residualBuyPrice } from "./infer";
import { EPS } from "./lots";
import type { Anomaly, CorporateAction, Currency, ISODate, LedgerEvent } from "./types";

/**
 * Trade imports: Zerodha Console tradebook and US history. Parsers collect
 * every row error; the caller writes nothing unless `errors` is empty
 * (all-or-nothing, inside one Pool transaction).
 */

export interface RowError {
  /** 1-based file line (header = 1). */
  row: number;
  message: string;
}

const CONSOLE_HEADERS = [
  "symbol",
  "isin",
  "trade_date",
  "exchange",
  "segment",
  "series",
  "trade_type",
  "auction",
  "quantity",
  "price",
  "trade_id",
  "order_id",
  "order_execution_time",
];
const US_HEADERS = ["date", "symbol", "side", "quantity", "price", "order_id"];

const isDate = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s);

/**
 * Strict CSV: the header set must equal `expected` (any order).
 * ponytail: plain comma split — these exports have no quoted commas; a row that
 * had one fails the column-count check instead of misparsing.
 */
function parseStrict<T>(text: string, expected: string[], toRow: (r: Record<string, string>) => T | string) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const unknown = header.filter((h) => !expected.includes(h));
  const missing = expected.filter((h) => !header.includes(h));
  if (unknown.length || missing.length)
    return {
      rows: [] as (T & { row: number })[],
      errors: [{ row: 1, message: `unexpected headers: unknown [${unknown.join(", ")}], missing [${missing.join(", ")}]` }],
    };

  const rows: (T & { row: number })[] = [];
  const errors: RowError[] = [];
  lines.slice(1).forEach((line, i) => {
    const row = i + 2;
    if (!line.trim()) return;
    const cells = line.split(",").map((c) => c.trim().replace(/^"(.*)"$/, "$1"));
    if (cells.length !== header.length) {
      errors.push({ row, message: `expected ${header.length} columns, got ${cells.length}` });
      return;
    }
    const parsed = toRow(Object.fromEntries(header.map((h, j) => [h, cells[j]])));
    if (typeof parsed === "string") errors.push({ row, message: parsed });
    else rows.push({ ...parsed, row });
  });
  return { rows, errors };
}

/** Drop rows whose ref repeats an earlier row (it would collide on sourceRef). */
function rejectDuplicates<R extends { row: number }>(parsed: { rows: R[]; errors: RowError[] }, ref: (r: R) => string, label: string) {
  const seen = new Set<string>();
  const rows = parsed.rows.filter((r) => {
    if (!seen.has(ref(r))) return seen.add(ref(r));
    parsed.errors.push({ row: r.row, message: `duplicate ${label} ${ref(r)}` });
    return false;
  });
  return { rows, errors: parsed.errors.sort((a, b) => a.row - b.row) };
}

function trade(side: string, qtyText: string, priceText: string) {
  const s = side.toLowerCase();
  if (s !== "buy" && s !== "sell") return `bad side "${side}"`;
  const qty = Number(qtyText);
  const price = Number(priceText);
  if (!(qty > 0) || !Number.isFinite(qty)) return `bad quantity "${qtyText}"`;
  if (!(price > 0) || !Number.isFinite(price)) return `bad price "${priceText}"`;
  return { side: s as "buy" | "sell", qty, price };
}

export interface ConsoleTrade {
  row: number;
  symbol: string;
  isin: string;
  exchange: string;
  tradeDate: ISODate;
  side: "buy" | "sell";
  qty: number;
  price: number;
  tradeId: string;
  orderId: string;
  /** As exported (IST, no offset); may be empty. */
  executedAt: string;
}

export function parseConsoleTradebook(text: string) {
  const parsed = parseStrict<Omit<ConsoleTrade, "row">>(text, CONSOLE_HEADERS, (r) => {
    if (!r.symbol) return "symbol is empty";
    if (!isDate(r.trade_date)) return `bad trade_date "${r.trade_date}"`;
    const t = trade(r.trade_type, r.quantity, r.price);
    if (typeof t === "string") return t;
    if (!r.trade_id) return "trade_id is empty";
    if (r.order_execution_time && Number.isNaN(Date.parse(r.order_execution_time)))
      return `bad order_execution_time "${r.order_execution_time}"`;
    return {
      ...t,
      symbol: r.symbol,
      isin: r.isin,
      exchange: r.exchange,
      tradeDate: r.trade_date,
      tradeId: r.trade_id,
      orderId: r.order_id,
      executedAt: r.order_execution_time,
    };
  });
  return rejectDuplicates(parsed, (r) => r.tradeId, "trade_id");
}

function convert<R extends { row: number }>(rows: R[], build: (r: R) => LedgerEvent | string) {
  const events: LedgerEvent[] = [];
  const errors: RowError[] = [];
  for (const r of rows) {
    const e = build(r);
    if (typeof e === "string") errors.push({ row: r.row, message: e });
    else events.push(e);
  }
  return { events, errors };
}

const withIst = (t: string) => (/(Z|[+-]\d{2}:\d{2})$/i.test(t) ? t : `${t}+05:30`);

/** Console rows → csv events (INR, rate 1). `resolve` maps a row to an instrument id. */
export const toEvents = (rows: ConsoleTrade[], resolve: (r: ConsoleTrade) => string | undefined) =>
  convert(rows, (r) => {
    const instrumentId = resolve(r);
    if (!instrumentId) return `unknown instrument ${r.exchange}:${r.symbol} (${r.isin})`;
    const sourceRef = `csv:${r.tradeId}`;
    return {
      id: sourceRef,
      sourceRef,
      instrumentId,
      type: r.side,
      date: r.tradeDate,
      executedAt: r.executedAt ? withIst(r.executedAt) : undefined,
      qty: r.qty,
      price: r.price,
      currency: "INR",
      fxRateInr: 1,
      source: "csv",
      approximate: false,
    };
  });

/** Min/max event date, so the caller prefetches FX for the range BEFORE the DB transaction. */
export function dateRange(events: LedgerEvent[]): { from: ISODate; to: ISODate } | null {
  if (!events.length) return null;
  const dates = events.map((e) => e.date).sort();
  return { from: dates[0], to: dates[dates.length - 1] };
}

/**
 * Insert split/bonus events from the instrument's action history (Yahoo, via
 * corporate_actions) so an import that starts years ago replays to today's
 * broker qty. Only actions after the instrument's first imported trade count.
 * A bonus is dated at its ex-date (allotment unknown) and marked approximate.
 */
export function applyHistoricalActions(events: LedgerEvent[], actions: CorporateAction[]): LedgerEvent[] {
  const first = new Map<string, LedgerEvent>();
  for (const e of events) {
    const f = first.get(e.instrumentId);
    if (!f || e.date < f.date) first.set(e.instrumentId, e);
  }
  const extra = actions.flatMap((a) => {
    const f = first.get(a.instrumentId);
    if (!f || a.exDate <= f.date) return [];
    return [
      actionEvent({
        action: a,
        date: a.exDate,
        heldQty: 0,
        currency: f.currency,
        // Zero-cost lot: the rate never multiplies anything; any non-null rate will do.
        fxRateInr: f.fxRateInr,
        source: f.source,
        approximate: a.kind === "bonus",
      }),
    ];
  });
  return [...events, ...extra];
}

/**
 * After an import, compare the replayed qty with the broker's. A shortfall
 * becomes an approximate opening for the residual, priced so the avg matches
 * the broker's, and is flagged for review. A surplus is only flagged.
 */
export function reconcile(p: {
  instrumentId: string;
  date: ISODate;
  replayedQty: number;
  /** Weighted-average basis (replay().positions). */
  replayedCost: number;
  brokerQty: number;
  brokerAvg: number;
  currency: Currency;
  fxRateInr: number;
}): { residual: number; event?: LedgerEvent; anomaly?: Anomaly } {
  const residual = p.brokerQty - p.replayedQty;
  if (Math.abs(residual) <= EPS) return { residual: 0 };
  if (residual < 0)
    return {
      residual,
      anomaly: {
        kind: "exceeds_broker",
        instrumentId: p.instrumentId,
        message: `replayed ${p.replayedQty} exceeds broker ${p.brokerQty}`,
      },
    };
  const implied = residualBuyPrice(p.replayedCost, residual, p.brokerQty, p.brokerAvg);
  const price = implied > 0 && Number.isFinite(implied) ? implied : p.brokerAvg;
  const sourceRef = `reconcile:${p.instrumentId}:${p.date}`;
  return {
    residual,
    event: {
      id: sourceRef,
      sourceRef,
      instrumentId: p.instrumentId,
      type: "opening",
      date: p.date,
      qty: residual,
      price,
      currency: p.currency,
      fxRateInr: p.fxRateInr,
      source: "opening",
      approximate: true,
    },
    anomaly: {
      kind: "unexplained_opening",
      instrumentId: p.instrumentId,
      eventId: sourceRef,
      message: `broker holds ${residual} more than the imported trades explain`,
    },
  };
}

/**
 * US history. Assumed minimal CSV `date,symbol,side,quantity,price,order_id`;
 * the real INDmoney format is pinned by the U1 spike.
 */
export interface UsHistoryRow {
  row: number;
  date: ISODate;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  /** USD. */
  price: number;
  ref: string;
}

export function parseUsHistory(text: string) {
  const parsed = parseStrict<Omit<UsHistoryRow, "row">>(text, US_HEADERS, (r) => {
    if (!isDate(r.date)) return `bad date "${r.date}"`;
    if (!r.symbol) return "symbol is empty";
    if (!r.order_id) return "order_id is empty";
    const t = trade(r.side, r.quantity, r.price);
    if (typeof t === "string") return t;
    return { ...t, date: r.date, symbol: r.symbol, ref: r.order_id };
  });
  return rejectDuplicates(parsed, (r) => r.ref, "order_id");
}

/** `fxRateFor` is the caller's prefetched, weekend-forward-filled USD→INR map. */
export const usHistoryToEvents = (
  rows: UsHistoryRow[],
  resolve: (r: UsHistoryRow) => string | undefined,
  fxRateFor: (date: ISODate) => number | undefined,
) =>
  convert(rows, (r) => {
    const instrumentId = resolve(r);
    if (!instrumentId) return `unknown instrument ${r.symbol}`;
    const fxRateInr = fxRateFor(r.date);
    if (!fxRateInr) return `no FX rate for ${r.date}`;
    const sourceRef = `us_history:${r.ref}`;
    return {
      id: sourceRef,
      sourceRef,
      instrumentId,
      type: r.side,
      date: r.date,
      qty: r.qty,
      price: r.price,
      currency: "USD",
      fxRateInr,
      source: "us_history",
      approximate: false,
    };
  });
