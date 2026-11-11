// Server-only view module. Portfolio value history is derived ON READ (no portfolio_values
// table, U17 decision): ledger replay gives the shares held on each day, raw prices_daily
// closes value them (scaled by corporate actions the ledger hasn't credited yet, U11a
// pendingFactor), and fx_daily converts US holdings at each day's rate. A ledger correction
// or a late split therefore never leaves stale derived rows.
//
// getHistoryView() resolves the actor (DAL rule), loads, and hands everything to the pure
// buildHistory(), which also redacts: hide-amounts actors get a time-weighted index
// (100 at the range start) and day P&L as a percentage only.
import { and, gte, inArray } from "drizzle-orm";
import { db } from "@/db";
import { fxDaily, instruments, pricesDaily } from "@/db/schema";
import { type Actor, requireActor } from "@/lib/auth/access";
import { type FieldPolicy, type Redacted, redactForActor } from "@/lib/auth/redact";
import { unappliedActions } from "@/lib/ledger/corporate-actions";
import { EPS, liveEvents, openQty, replay } from "@/lib/ledger/lots";
import { isoInMarket, loadActions, loadLedger } from "@/lib/ledger/queries";
import { addDays, type CorporateAction, effDate, factor, type LedgerEvent, type Supersession } from "@/lib/ledger/types";
import type { Currency, ISODate, Market } from "@/lib/returns/types";

export const HISTORY_RANGES = ["1m", "3m", "6m", "1y", "all"] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];
export const HISTORY_SCOPES = ["all", "in", "us"] as const;
export type HistoryScope = (typeof HISTORY_SCOPES)[number];
const MONTHS: Record<Exclude<HistoryRange, "all">, number> = { "1m": 1, "3m": 3, "6m": 6, "1y": 12 };

export interface HistoryInstrument {
  id: string;
  market: Market;
  currency: Currency;
  /** Raw closes, ascending by date. */
  closes: { date: ISODate; close: number }[];
}

export interface HistoryInputs {
  instruments: HistoryInstrument[];
  /** Every ledger event (superseded included) plus the link rows. */
  events: LedgerEvent[];
  supersessions: Supersession[];
  actions: CorporateAction[];
  /** USD/INR, ascending by date. */
  fx: { date: ISODate; usdInr: number }[];
  today: ISODate;
}

export interface HistoryPoint {
  date: ISODate;
  /** INR. */
  value: number;
  /** INR cost of the lots still open. */
  invested: number;
  /** Net INR put in since the previous point: buys − sells − dividends received. */
  flow: number;
  /** Value change minus `flow`: a buy day is not a gain. */
  dayPnl: number;
  /** dayPnl over the money at risk (previous value plus today's net inflow). */
  dayPnlPct: number | null;
  /** Time-weighted index, 100 at the first point of the range. */
  index: number;
}

export interface HistorySummary {
  from: ISODate | null;
  to: ISODate | null;
  startValue: number;
  endValue: number;
  invested: number;
  /** Sum of day P&L after the first point (the change the index measures). */
  pnl: number;
  /** Time-weighted return over the range. */
  returnPct: number | null;
  upDays: number;
  downDays: number;
  best: { date: ISODate; pct: number } | null;
  worst: { date: ISODate; pct: number } | null;
}

export const HISTORY_POINT_POLICY = ["value", "invested", "flow", "dayPnl"] as const satisfies FieldPolicy<HistoryPoint>;
export const HISTORY_SUMMARY_POLICY = ["startValue", "endValue", "invested", "pnl"] as const satisfies FieldPolicy<HistorySummary>;

export type HistoryPointDto = Redacted<HistoryPoint, (typeof HISTORY_POINT_POLICY)[number]>;
export type HistorySummaryDto = Redacted<HistorySummary, (typeof HISTORY_SUMMARY_POLICY)[number]>;
export interface HistorySeries {
  points: HistoryPointDto[];
  summary: HistorySummaryDto;
}
export interface HistoryView {
  amountsHidden: boolean;
  range: HistoryRange;
  /** No ledger events at all. */
  empty: boolean;
  scopes: Record<HistoryScope, HistorySeries>;
}

// ---------- pure helpers ----------

/** Holdings of one instrument after each date its replayed lots change. */
interface Step {
  date: ISODate;
  qty: number;
  investedNative: number;
  investedInr: number;
}

/**
 * One replay per distinct effective date (not per day), so the cost is
 * O(events²) per instrument and independent of the number of days.
 */
function stepsOf(mine: LedgerEvent[]): Step[] {
  const dates = [...new Set(mine.filter((e) => e.type !== "dividend").map(effDate))].sort();
  return dates.map((date) => {
    const { openLots } = replay(mine.filter((e) => effDate(e) <= date));
    let qty = 0;
    let investedNative = 0;
    let investedInr = 0;
    for (const l of openLots) {
      const q = openQty(l);
      qty += q;
      investedNative += q * l.costPerShare;
      investedInr += q * l.costPerShare * l.fxRateAtOpen;
    }
    return { date, qty, investedNative, investedInr };
  });
}

/** Net INR into the portfolio from one event (investor's view: buying puts money in). */
function flowOf(e: LedgerEvent): number {
  const amt = e.qty * e.price * e.fxRateInr;
  if (e.type === "buy" || e.type === "opening") return amt;
  if (e.type === "sell" || e.type === "dividend") return -amt;
  return 0;
}

function rangeStart(range: HistoryRange, today: ISODate): ISODate | null {
  if (range === "all") return null;
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - MONTHS[range]);
  return d.toISOString().slice(0, 10);
}

const EMPTY_SUMMARY: HistorySummary = {
  from: null,
  to: null,
  startValue: 0,
  endValue: 0,
  invested: 0,
  pnl: 0,
  returnPct: null,
  upDays: 0,
  downDays: 0,
  best: null,
  worst: null,
};

/**
 * Pure: inputs → per-scope daily series, redacted for the actor.
 * Days are the dates on which at least one in-scope instrument has a stored close:
 * weekends and joint holidays are absent (a gap, never a zero), and an instrument
 * without a close that day (its own market's holiday) carries its last close.
 * Work is O(days × instruments) plus one replay per event date.
 */
export function buildHistory(inputs: HistoryInputs, actor: Actor, range: HistoryRange): HistoryView {
  const live = liveEvents(inputs.events, inputs.supersessions);
  const byInst = new Map<string, LedgerEvent[]>();
  for (const e of live) {
    const list = byInst.get(e.instrumentId);
    if (list) list.push(e);
    else byInst.set(e.instrumentId, [e]);
  }
  const insts = inputs.instruments.filter((i) => byInst.has(i.id));

  // Union day axis, and which days each market actually traded.
  const traded: Record<Market, Set<ISODate>> = { IN: new Set(), US: new Set() };
  for (const i of insts) for (const c of i.closes) if (c.date <= inputs.today) traded[i.market].add(c.date);
  const firstEvent = live.reduce<ISODate | null>((m, e) => (m == null || e.date < m ? e.date : m), null);
  const days = [...new Set([...traded.IN, ...traded.US])].filter((d) => firstEvent != null && d >= firstEvent).sort();
  const n = days.length;

  // FX per day, carrying the last known rate (holidays, weekends).
  const fxDay = new Float64Array(n).fill(Number.NaN);
  for (let k = 0, j = -1; k < n; k++) {
    while (j + 1 < inputs.fx.length && inputs.fx[j + 1].date <= days[k]) j++;
    fxDay[k] = j >= 0 ? inputs.fx[j].usdInr : (inputs.fx[0]?.usdInr ?? Number.NaN);
  }

  // Per-market value and invested on every axis day; flows per market.
  const value: Record<Market, Float64Array> = { IN: new Float64Array(n), US: new Float64Array(n) };
  const invested: Record<Market, Float64Array> = { IN: new Float64Array(n), US: new Float64Array(n) };
  const flows: Record<Market, { date: ISODate; amt: number }[]> = { IN: [], US: [] };
  const firstOf: Record<Market, ISODate | null> = { IN: null, US: null };

  for (const inst of insts) {
    const mine = byInst.get(inst.id)!;
    for (const e of mine) {
      const amt = flowOf(e);
      if (amt) flows[inst.market].push({ date: e.date, amt });
      const f = firstOf[inst.market];
      if (f == null || e.date < f) firstOf[inst.market] = e.date;
    }
    const steps = stepsOf(mine);
    const pending = unappliedActions(inst.id, inputs.actions, mine).sort((a, b) => a.exDate.localeCompare(b.exDate));
    const v = value[inst.market];
    const inv = invested[inst.market];
    let s = -1;
    let c = -1;
    let p = -1;
    let pf = 1;
    for (let k = 0; k < n; k++) {
      const d = days[k];
      while (s + 1 < steps.length && steps[s + 1].date <= d) s++;
      while (c + 1 < inst.closes.length && inst.closes[c + 1].date <= d) c++;
      while (p + 1 < pending.length && pending[p + 1].exDate <= d) pf *= factor(pending[++p].ratio);
      const st = s >= 0 ? steps[s] : null;
      if (!st || st.qty <= EPS) continue;
      // No close stored yet for this instrument: hold it at cost rather than at zero.
      const native = c >= 0 ? st.qty * pf * inst.closes[c].close : st.investedNative;
      const fx = inst.currency === "INR" ? 1 : Number.isFinite(fxDay[k]) ? fxDay[k] : st.investedInr / st.investedNative;
      v[k] += native * fx;
      inv[k] += st.investedInr;
    }
  }

  const start = rangeStart(range, inputs.today);
  const scopeSeries = (markets: Market[]): HistorySeries => {
    const first = markets
      .map((m) => firstOf[m])
      .filter((d): d is ISODate => d != null)
      .sort()[0];
    const idx: number[] = [];
    for (let k = 0; k < n; k++) if (first && days[k] >= first && markets.some((m) => traded[m].has(days[k]))) idx.push(k);
    const fl = markets.flatMap((m) => flows[m]).sort((a, b) => a.date.localeCompare(b.date));

    const points: HistoryPoint[] = [];
    let prevValue = 0;
    let f = 0;
    let index = 100;
    for (const k of idx) {
      const d = days[k];
      let flow = 0;
      while (f < fl.length && fl[f].date <= d) flow += fl[f++].amt;
      const val = markets.reduce((sum, m) => sum + value[m][k], 0);
      const dayPnl = val - prevValue - flow;
      const base = prevValue + Math.max(flow, 0);
      const dayPnlPct = base > EPS ? dayPnl / base : null;
      prevValue = val;
      if (start != null && d < start) continue;
      // The range's first point anchors the index; later points compound day returns.
      if (points.length) index *= 1 + (dayPnlPct ?? 0);
      points.push({
        date: d,
        value: val,
        invested: markets.reduce((sum, m) => sum + invested[m][k], 0),
        flow,
        dayPnl,
        dayPnlPct,
        index,
      });
    }

    const summary: HistorySummary = { ...EMPTY_SUMMARY };
    if (points.length) {
      const last = points[points.length - 1];
      Object.assign(summary, {
        from: points[0].date,
        to: last.date,
        startValue: points[0].value,
        endValue: last.value,
        invested: last.invested,
        pnl: points.slice(1).reduce((sum, p) => sum + p.dayPnl, 0),
        returnPct: last.index / 100 - 1,
      });
      for (const p of points) {
        if (p.dayPnlPct == null) continue;
        if (p.dayPnlPct > 0) summary.upDays++;
        if (p.dayPnlPct < 0) summary.downDays++;
        if (!summary.best || p.dayPnlPct > summary.best.pct) summary.best = { date: p.date, pct: p.dayPnlPct };
        if (!summary.worst || p.dayPnlPct < summary.worst.pct) summary.worst = { date: p.date, pct: p.dayPnlPct };
      }
    }
    return {
      points: points.map((p) => redactForActor(actor, p, HISTORY_POINT_POLICY)),
      summary: redactForActor(actor, summary, HISTORY_SUMMARY_POLICY),
    };
  };

  return {
    amountsHidden: actor.hideAmounts,
    range,
    empty: live.length === 0,
    scopes: { all: scopeSeries(["IN", "US"]), in: scopeSeries(["IN"]), us: scopeSeries(["US"]) },
  };
}

// ---------- loader ----------

export async function loadHistoryInputs(now: Date): Promise<HistoryInputs> {
  const today = isoInMarket(now, "INR").slice(0, 10);
  const { events, supersessions } = await loadLedger(db);
  const live = liveEvents(events, supersessions);
  const ids = [...new Set(live.map((e) => e.instrumentId))];
  if (!ids.length) return { instruments: [], events, supersessions, actions: [], fx: [], today };

  // A few days before the first event, so a holiday on day one still has a close to carry.
  const since = addDays(live.reduce((m, e) => (e.date < m ? e.date : m), today), -10);
  const [instRows, actions, closes, fx] = await Promise.all([
    db
      .select({ id: instruments.id, market: instruments.market, currency: instruments.currency })
      .from(instruments)
      .where(inArray(instruments.id, ids)),
    loadActions(db, ids),
    db
      .select({ id: pricesDaily.instrumentId, date: pricesDaily.date, close: pricesDaily.close })
      .from(pricesDaily)
      .where(and(inArray(pricesDaily.instrumentId, ids), gte(pricesDaily.date, since)))
      .orderBy(pricesDaily.date),
    db.select({ date: fxDaily.date, usdInr: fxDaily.usdInr }).from(fxDaily).where(gte(fxDaily.date, since)).orderBy(fxDaily.date),
  ]);
  const closesOf = new Map<string, { date: ISODate; close: number }[]>();
  for (const r of closes) {
    const c = { date: r.date, close: Number(r.close) };
    const list = closesOf.get(r.id);
    if (list) list.push(c);
    else closesOf.set(r.id, [c]);
  }

  return {
    instruments: instRows.map((i) => ({ ...i, closes: closesOf.get(i.id) ?? [] })),
    events,
    supersessions,
    actions,
    fx: fx.map((r) => ({ date: r.date, usdInr: Number(r.usdInr) })),
    today,
  };
}

export async function getHistoryView(range: HistoryRange): Promise<HistoryView> {
  const actor = await requireActor();
  return buildHistory(await loadHistoryInputs(new Date()), actor, range);
}
