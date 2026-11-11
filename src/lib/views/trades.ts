// Server-only view module: the ledger as a feed of events by date (fills, tradebook
// rows, inferred estimates, manual corrections, US history, dividends, corporate actions).
// getTradesView() resolves the actor; the pure buildTrades() filters, orders and redacts.
// Superseded events are history: hidden unless asked for, and marked when shown.
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { instruments } from "@/db/schema";
import { type Actor, requireActor } from "@/lib/auth/access";
import { type FieldPolicy, type Redacted, redactForActor } from "@/lib/auth/redact";
import { isoInMarket, loadLedger } from "@/lib/ledger/queries";
import type { EventType, LedgerEvent, Supersession } from "@/lib/ledger/types";
import { type MarketStatus, marketStatus } from "@/lib/market/live";
import type { Currency, ISODate, Market } from "@/lib/returns/types";

export const TRADE_TYPES = ["all", "buy", "sell", "dividend", "action"] as const;
export type TradeTypeFilter = (typeof TRADE_TYPES)[number];
export type MarketFilter = "all" | "in" | "us";
export interface TradeFilters {
  market: MarketFilter;
  type: TradeTypeFilter;
  /** Show superseded events too. */
  history: boolean;
  /** Only this instrument (ledger page). */
  instrumentId?: string;
}

/** DB source enum: the pure core's EventSource plus 'action' (corporate actions written by ingest/EOD). */
export type TradeSource = LedgerEvent["source"] | "action";

export interface TradeInstrument {
  id: string;
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
}

export interface TradesInputs {
  events: LedgerEvent[];
  supersessions: Supersession[];
  instruments: TradeInstrument[];
}

export interface TradeRow {
  id: string;
  date: ISODate;
  executedAt: string | null;
  instrumentId: string;
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  type: EventType;
  source: TradeSource;
  approximate: boolean;
  /** Per share, native (net per share for a dividend). Null for a split or bonus. */
  price: number | null;
  /** "2:1" for a split or bonus. */
  ratio: string | null;
  exDate: ISODate | null;
  qty: number;
  amountNative: number | null;
  amountInr: number | null;
  superseded: boolean;
  /** Sources of the events that replaced this one. */
  replacedBy: TradeSource[];
}

export const TRADE_POLICY = ["qty", "amountNative", "amountInr"] as const satisfies FieldPolicy<TradeRow>;
export type TradeRowDto = Redacted<TradeRow, (typeof TRADE_POLICY)[number]>;

export interface TradesView {
  amountsHidden: boolean;
  rows: TradeRowDto[];
  /** Rows matching the filters before the display cap. */
  total: number;
  /** Superseded events the current filters hide (0 when history is shown). */
  hiddenSuperseded: number;
}

/** ponytail: newest N only; add paging when the ledger outgrows it. */
export const TRADES_CAP = 400;

const TYPE_GROUP: Record<EventType, TradeTypeFilter> = {
  buy: "buy",
  opening: "buy",
  sell: "sell",
  dividend: "dividend",
  split: "action",
  bonus: "action",
};

/** Pure: newest first (same day: latest execution first), filtered and redacted for the actor. Export passes cap = Infinity. */
export function buildTrades(inputs: TradesInputs, actor: Actor, f: TradeFilters, cap = TRADES_CAP): TradesView {
  const byInst = new Map(inputs.instruments.map((i) => [i.id, i]));
  const byId = new Map(inputs.events.map((e) => [e.id, e]));
  const replaced = new Map<string, TradeSource[]>();
  for (const s of inputs.supersessions) {
    const by = byId.get(s.supersedingId);
    if (by) replaced.set(s.supersededId, [...(replaced.get(s.supersededId) ?? []), by.source]);
  }

  const matching = inputs.events.filter((e) => {
    const i = byInst.get(e.instrumentId);
    if (!i) return false;
    if (f.instrumentId && e.instrumentId !== f.instrumentId) return false;
    if (f.market !== "all" && i.market !== f.market.toUpperCase()) return false;
    return f.type === "all" || TYPE_GROUP[e.type] === f.type;
  });
  const visible = f.history ? matching : matching.filter((e) => !replaced.has(e.id));
  visible.sort((a, b) => b.date.localeCompare(a.date) || (b.executedAt ?? "").localeCompare(a.executedAt ?? ""));

  const rows = visible.slice(0, cap).map((e): TradeRow => {
    const i = byInst.get(e.instrumentId)!;
    const action = e.type === "split" || e.type === "bonus";
    const amountNative = action ? null : e.qty * e.price;
    return {
      id: e.id,
      date: e.date,
      executedAt: e.executedAt ?? null,
      instrumentId: e.instrumentId,
      symbol: i.symbol,
      name: i.name,
      market: i.market,
      currency: i.currency,
      type: e.type,
      source: e.source,
      approximate: e.approximate,
      price: action ? null : e.price,
      ratio: e.ratio ? `${e.ratio.num}:${e.ratio.den}` : null,
      exDate: e.exDate ?? null,
      qty: e.qty,
      amountNative,
      amountInr: amountNative == null ? null : amountNative * e.fxRateInr,
      superseded: replaced.has(e.id),
      replacedBy: replaced.get(e.id) ?? [],
    };
  });

  return {
    amountsHidden: actor.hideAmounts,
    rows: rows.map((r) => redactForActor(actor, r, TRADE_POLICY)),
    total: visible.length,
    hiddenSuperseded: matching.length - visible.length,
  };
}

export async function loadTradesInputs(instrumentIds?: string[]): Promise<TradesInputs> {
  const { events, supersessions } = await loadLedger(db, instrumentIds);
  const ids = [...new Set(events.map((e) => e.instrumentId))];
  const rows = ids.length
    ? await db
        .select({
          id: instruments.id,
          symbol: instruments.brokerSymbol,
          name: instruments.name,
          market: instruments.market,
          currency: instruments.currency,
        })
        .from(instruments)
        .where(inArray(instruments.id, ids))
    : [];
  return { events, supersessions, instruments: rows };
}

export async function getTradesView(f: TradeFilters): Promise<TradesView> {
  const actor = await requireActor();
  return buildTrades(await loadTradesInputs(), actor, f);
}

// ---------- Daily trades: what was bought or sold, today first ----------

/** Real executions only: Kite fills (today's land via kite-sync → ingestFills), tradebook CSV, US history. */
const EXECUTION_SOURCES: ReadonlySet<TradeSource> = new Set(["fill", "csv", "us_history"]);

export interface DailyTradeRow {
  id: string;
  instrumentId: string;
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  side: "buy" | "sell";
  qty: number;
  /** Per share, native. A price, not an amount: kept for hide-amounts viewers. */
  price: number;
  valueNative: number;
  /** Null when the event's FX rate is unknown. */
  valueInr: number | null;
  /** ISO timestamp with offset when known, else the trade date. */
  executedAt: string;
  source: TradeSource;
}

export const DAILY_TRADE_POLICY = ["qty", "valueNative", "valueInr"] as const satisfies FieldPolicy<DailyTradeRow>;
export type DailyTradeRowDto = Redacted<DailyTradeRow, (typeof DAILY_TRADE_POLICY)[number]>;

export interface DailyTradesToday {
  date: ISODate;
  rows: DailyTradeRowDto[];
  buyValueInr: number;
  sellValueInr: number;
}
export const DAILY_TOTALS_POLICY = ["buyValueInr", "sellValueInr"] as const satisfies FieldPolicy<DailyTradesToday>;

export interface DailyTradesView {
  today: Redacted<DailyTradesToday, (typeof DAILY_TOTALS_POLICY)[number]>;
  /** Days before today with at least one trade, newest first. */
  earlier: { date: ISODate; rows: DailyTradeRowDto[] }[];
  amountsHidden: boolean;
  markets: MarketStatus;
}

const DAY_MS = 86_400_000;

/**
 * Pure. Groups by the IST calendar date of the execution for BOTH markets (the owner is in
 * India): a US trade at 15:00 New York lands on the next IST day. Events without a time use
 * their trade date. Window: today plus the previous `days - 1` IST days. Newest first.
 */
export function buildDailyTrades(inputs: TradesInputs, actor: Actor, now: Date, days = 30): DailyTradesView {
  const byInst = new Map(inputs.instruments.map((i) => [i.id, i]));
  const superseded = new Set(inputs.supersessions.map((s) => s.supersededId));
  const today = isoInMarket(now, "INR").slice(0, 10);
  const from = new Date(Date.parse(today) - (days - 1) * DAY_MS).toISOString().slice(0, 10);

  const rows = inputs.events
    .flatMap((e) => {
      const i = byInst.get(e.instrumentId);
      if (!i || superseded.has(e.id) || !EXECUTION_SOURCES.has(e.source)) return [];
      if (e.type !== "buy" && e.type !== "sell") return [];
      const date = e.executedAt ? isoInMarket(new Date(e.executedAt), "INR").slice(0, 10) : e.date;
      if (date < from || date > today) return [];
      const valueNative = e.qty * e.price;
      const valueInr = valueNative * e.fxRateInr;
      const row: DailyTradeRow = {
        id: e.id,
        instrumentId: e.instrumentId,
        symbol: i.symbol,
        name: i.name,
        market: i.market,
        currency: i.currency,
        side: e.type,
        qty: e.qty,
        price: e.price,
        valueNative,
        valueInr: Number.isFinite(valueInr) ? valueInr : null,
        executedAt: e.executedAt ?? e.date,
        source: e.source,
      };
      const at = Date.parse(e.executedAt ?? `${e.date}T00:00:00+05:30`);
      return [{ date, at, row }];
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.at - a.at);

  const sum = (side: "buy" | "sell") =>
    rows.filter((r) => r.date === today && r.row.side === side).reduce((s, r) => s + (r.row.valueInr ?? 0), 0);
  const redact = (date: ISODate) =>
    rows.filter((r) => r.date === date).map((r) => redactForActor(actor, r.row, DAILY_TRADE_POLICY));
  const earlierDates = [...new Set(rows.map((r) => r.date))].filter((d) => d !== today);

  return {
    today: redactForActor(
      actor,
      { date: today, rows: redact(today), buyValueInr: sum("buy"), sellValueInr: sum("sell") },
      DAILY_TOTALS_POLICY,
    ),
    earlier: earlierDates.map((date) => ({ date, rows: redact(date) })),
    amountsHidden: actor.hideAmounts,
    markets: marketStatus(now),
  };
}

export async function getDailyTradesView({ days = 30 }: { days?: number } = {}): Promise<DailyTradesView> {
  const actor = await requireActor();
  return buildDailyTrades(await loadTradesInputs(), actor, new Date(), days);
}
