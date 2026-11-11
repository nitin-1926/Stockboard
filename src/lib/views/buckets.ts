// Server-only view module (same pattern as holdings.ts): getBucketsView() /
// getBucketDetailView() resolve the actor, load, and hand everything to the pure
// buildBucketsView(), which does the math and the hide-amounts redaction.
//
// Honesty rules (R13): a member is a buy event (or opening), so a sold lot stays in its
// bucket and its realized P&L counts. Paper members (watch items) are equal-weighted at
// PAPER_NOTIONAL_INR (returns/aggregate.ts) each and never enter money totals; they
// meet real money only in `combined`. Alpha compares the bucket's real cash flows with
// the same rupees put into Nifty 50 (NIFTYBEES) for India and the S&P 500 (SPY, in INR)
// for US members.
import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  type BucketColor,
  bucketMembers,
  buckets,
  corporateActions,
  dividends,
  fxDaily,
  instruments,
  ledgerEvents,
  priceLatest,
  pricesDaily,
  settings,
  watchItems,
} from "@/db/schema";
import { type Actor, can, requireActor } from "@/lib/auth/access";
import { type FieldPolicy, type Redacted, redactForActor } from "@/lib/auth/redact";
import { MEMBER_EVENT_TYPES } from "@/lib/buckets/inherit";
import { liveEvents, replay } from "@/lib/ledger/lots";
import { isoInMarket, loadLedger } from "@/lib/ledger/queries";
import { effDate, type LedgerLot } from "@/lib/ledger/types";
import { aggregate, type PositionInput } from "@/lib/returns/aggregate";
import { benchmark, type IndexSeries, totalReturnIndex } from "@/lib/returns/benchmark";
import { heldQtyOn, positionPnl, US_DIVIDEND_WITHHOLDING } from "@/lib/returns/pnl";
import type { Currency, Dividend, ISODate, Market, PriceSeries } from "@/lib/returns/types";
import { annualizeOrAbsolute, daysBetween, type Flow } from "@/lib/returns/xirr";

// ---------- inputs ----------

export interface BucketInput {
  id: string;
  name: string;
  description: string | null;
  color: BucketColor;
  createdBy: string;
}

export interface InstrumentInput {
  id: string;
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  /** Latest price, native; null when unavailable. */
  price: number | null;
  /** Per-share gross on the RAW share basis of its ex-date (as stored). */
  dividends: Dividend[];
  /** Live split events; lot quantities are on the post-split basis. */
  splits: { exDate: ISODate; ratio: number }[];
  /** Raw daily closes, detail view only (chart). */
  closes?: PriceSeries;
}

interface MemberBase {
  id: string;
  bucketId: string;
  addedBy: string;
  instrumentId: string;
}
export type MemberInput =
  | (MemberBase & {
      kind: "buy_event";
      eventId: string;
      lot: LedgerLot;
      approximate: boolean;
      /** This lot's pro-rata slice of later bonus lots (bonusSlices); zero cost. */
      bonusLots?: LedgerLot[];
    })
  | (MemberBase & { kind: "watch_item"; watchItemId: string; priceAtAdd: number | null; watchAddedAt: Date });

export interface BucketsInputs {
  buckets: BucketInput[];
  members: MemberInput[];
  instruments: Record<string, InstrumentInput>;
  /** Latest USD/INR. */
  fx: { usdInr: number; date: ISODate } | null;
  /** date → USD/INR (business days). */
  fxSeries: PriceSeries;
  /** Total-return series; null = no stored history yet (U17 backfills it). US carries `fx`. */
  benchmarks: Record<Market, IndexSeries | null>;
  /** Dividend withholding (US treaty 25%; India TDS from settings). */
  withholding: Record<Market, number>;
  ownerEmail: string | null;
  now: Date;
  /** Detail view: things the actor could add (open buy lots, active watch items). */
  options?: { lots: LotOption[]; watch: WatchOption[] };
}

export interface LotOption {
  eventId: string;
  instrumentId: string;
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  boughtOn: ISODate;
  /** Buy price per share (a price, not an amount). */
  price: number;
}
export interface WatchOption {
  watchItemId: string;
  instrumentId: string;
  symbol: string;
  name: string;
  market: Market;
  addedOn: ISODate;
}

// ---------- DTOs ----------

export const BENCHMARK_LABEL: Record<Market, string> = { IN: "Nifty 50", US: "S&P 500" };

export type Alpha =
  | { market: Market; label: string; status: "ok"; alpha: number; annualized: boolean; benchmarkReturn: number | null }
  | { market: Market; label: string; status: "pending" | "na" };

export interface RealMetrics {
  /** Buy events counted (priced or fully sold). */
  count: number;
  open: number;
  sold: number;
  /** Open members without a price: left out of totals. */
  unpriced: number;
  costInr: number;
  valueInr: number;
  realizedInr: number;
  unrealizedInr: number;
  dividendsNetInr: number;
  totalReturnInr: number;
  /** Realized P&L as a share of all money put in (a %, kept for hide-amounts viewers). */
  realizedPct: number | null;
  returnPct: number | null;
  xirr: number | null;
  useAbsolute: boolean;
}
export const BUCKET_REAL_POLICY = [
  "costInr",
  "valueInr",
  "realizedInr",
  "unrealizedInr",
  "dividendsNetInr",
  "totalReturnInr",
] as const satisfies FieldPolicy<RealMetrics>;

export interface PaperMetrics {
  count: number;
  /** No price at add, no current price, or no FX for that day. */
  skipped: number;
  returnPct: number | null;
  annualizedPct: number | null;
  useAbsolute: boolean;
}

export interface BucketCard {
  id: string;
  name: string;
  description: string | null;
  color: BucketColor;
  createdBy: string;
  real: Redacted<RealMetrics, (typeof BUCKET_REAL_POLICY)[number]>;
  paper: PaperMetrics;
  combined: { returnPct: number | null; xirr: number | null; useAbsolute: boolean };
  alpha: Alpha[];
  canEdit: boolean;
  canArchive: boolean;
}

export interface RealMemberRow {
  id: string;
  kind: "real";
  eventId: string;
  instrumentId: string;
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  boughtOn: ISODate;
  buyPrice: number;
  price: number | null;
  status: "open" | "partly sold" | "sold";
  approximate: boolean;
  unpriced: boolean;
  qty: number;
  openQty: number;
  costInr: number;
  valueInr: number | null;
  realizedInr: number;
  unrealizedInr: number | null;
  dividendsInr: number;
  /** (realized + unrealized + net dividends) / cost of the whole lot. */
  returnPct: number | null;
  realizedPct: number | null;
  addedBy: string;
  canRemove: boolean;
}
export const MEMBER_POLICY = [
  "qty",
  "openQty",
  "costInr",
  "valueInr",
  "realizedInr",
  "unrealizedInr",
  "dividendsInr",
] as const satisfies FieldPolicy<RealMemberRow>;

export interface PaperMemberRow {
  id: string;
  kind: "paper";
  watchItemId: string;
  instrumentId: string;
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  addedOn: ISODate;
  priceAtAdd: number | null;
  price: number | null;
  returnPct: number | null;
  annualizedPct: number | null;
  skipped: "no price at add" | "no price" | "no FX" | null;
  addedBy: string;
  canRemove: boolean;
}

export interface ChartPoint {
  date: ISODate;
  portfolio: number;
  benchmark: number | null;
}
export interface BucketChart {
  points: ChartPoint[];
  /** Hide-amounts: both series are per ₹100 of money put in, not rupees. */
  normalized: boolean;
  benchmarkPending: boolean;
  benchmarkLabel: string;
}

export interface BucketDetail extends BucketCard {
  amountsHidden: boolean;
  realMembers: Redacted<RealMemberRow, (typeof MEMBER_POLICY)[number]>[];
  paperMembers: PaperMemberRow[];
  chart: BucketChart | null;
  canAddMember: boolean;
  options: { lots: LotOption[]; watch: WatchOption[] };
}

export interface BucketsView {
  amountsHidden: boolean;
  canCreate: boolean;
  buckets: BucketCard[];
}

// ---------- pure helpers ----------

/** Value on or before `d` in a date-keyed series, or null. Sorted keys are cached per series. */
const sortedKeys = new WeakMap<PriceSeries, ISODate[]>();
function at(series: PriceSeries | undefined, d: ISODate): number | null {
  if (!series) return null;
  let keys = sortedKeys.get(series);
  if (!keys) sortedKeys.set(series, (keys = Object.keys(series).sort()));
  let lo = 0;
  let hi = keys.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] <= d) [found, lo] = [mid, mid + 1];
    else hi = mid - 1;
  }
  return found < 0 ? null : series[keys[found]];
}

/** Splits after `d` multiply today's share count relative to that day's. */
const splitFactorAfter = (inst: InstrumentInput, d: ISODate) =>
  inst.splits.filter((s) => s.exDate > d).reduce((f, s) => f * s.ratio, 1);

/** Stored dividends are per RAW share; lots are post-split, so scale per-share down (U12 note). */
const adjustedDividends = (inst: InstrumentInput): Dividend[] =>
  inst.dividends.map((d) => ({ ...d, perShareGross: d.perShareGross / splitFactorAfter(inst, d.exDate) }));

const lotOpenQty = (l: LedgerLot) => l.qty - l.closed.reduce((s, c) => s + c.qty, 0);
const memberLots = (m: Extract<MemberInput, { kind: "buy_event" }>) => [m.lot, ...(m.bonusLots ?? [])];

/**
 * A bonus lot is its own zero-cost lot, not a bucket member, so without this a bucket would
 * miss the bonus gain. Each bonus lot of the instrument is split pro rata by the quantity
 * held at its ex-date, so `member` gets the slice issued on its own shares (and on its
 * earlier slices), with the same share of the bonus lot's later sales. `lots`: every lot of
 * the instrument (open and closed). ponytail: a lot fully sold before a later split isn't
 * rescaled by replay, which skews the ratio across that split; exact attribution would
 * need per-lot bonus tracking in replay.
 */
export function bonusSlices(member: LedgerLot, lots: LedgerLot[], bonuses: { eventId: string; exDate: ISODate }[]): LedgerLot[] {
  const out: LedgerLot[] = [];
  for (const b of [...bonuses].sort((x, y) => x.exDate.localeCompare(y.exDate))) {
    const bonusLot = lots.find((l) => l.eventId === b.eventId);
    if (!bonusLot) continue;
    const total = heldQtyOn(lots, b.exDate);
    const mine = heldQtyOn([member, ...out], b.exDate);
    if (total <= 1e-9 || mine <= 1e-9) continue;
    const f = mine / total;
    out.push({ ...bonusLot, qty: bonusLot.qty * f, closed: bonusLot.closed.map((c) => ({ ...c, qty: c.qty * f })) });
  }
  return out;
}
const ratio = (num: number, den: number) => (den > 0 ? num / den : null);

function displayAuthor(email: string, actor: Actor, ownerEmail: string | null) {
  if (actor.via !== "share-link") return email;
  return ownerEmail && email === ownerEmail ? "Owner" : "Contributor";
}

interface RealCalc {
  m: Extract<MemberInput, { kind: "buy_event" }>;
  inst: InstrumentInput;
  position: PositionInput;
  row: RealMemberRow;
  included: boolean;
}

function realCalc(
  m: Extract<MemberInput, { kind: "buy_event" }>,
  inputs: BucketsInputs,
  asOf: ISODate,
  actor: Actor,
  owner: string | null,
): RealCalc {
  const inst = inputs.instruments[m.instrumentId];
  const lot = m.lot;
  const lots = memberLots(m);
  const fxNow = inst.currency === "INR" ? 1 : (inputs.fx?.usdInr ?? null);
  const openQty = lots.reduce((s, l) => s + lotOpenQty(l), 0);
  const isOpen = openQty > 1e-9;
  const unpriced = isOpen && (inst.price == null || fxNow == null);
  const position: PositionInput = {
    lots,
    price: inst.price ?? 0,
    fxNow: fxNow ?? 0,
    dividends: adjustedDividends(inst),
    withholdingRate: inputs.withholding[inst.market],
  };
  const p = positionPnl({ ...position, asOf });
  const costInr = lot.qty * lot.costPerShare * lot.fxRateAtOpen;
  return {
    m,
    inst,
    position,
    included: !unpriced,
    row: {
      id: m.id,
      kind: "real",
      eventId: m.eventId,
      instrumentId: inst.id,
      symbol: inst.symbol,
      name: inst.name,
      market: inst.market,
      currency: inst.currency,
      boughtOn: lot.openDate,
      buyPrice: lot.costPerShare,
      price: inst.price,
      status: !isOpen ? "sold" : lots.some((l) => l.closed.length) ? "partly sold" : "open",
      approximate: m.approximate,
      unpriced,
      qty: lot.qty,
      openQty,
      costInr,
      valueInr: unpriced ? null : p.valueInr,
      realizedInr: p.realizedInr,
      unrealizedInr: unpriced ? null : p.unrealizedInr,
      dividendsInr: p.dividendsNetInr,
      returnPct: unpriced ? null : ratio(p.totalReturnInr, costInr),
      realizedPct: ratio(p.realizedInr, costInr),
      addedBy: displayAuthor(m.addedBy, actor, owner),
      canRemove: can(actor, "edit_own", { by: m.addedBy }),
    },
  };
}

function paperCalc(
  m: Extract<MemberInput, { kind: "watch_item" }>,
  inputs: BucketsInputs,
  asOf: ISODate,
  actor: Actor,
  owner: string | null,
) {
  const inst = inputs.instruments[m.instrumentId];
  const addedOn = isoInMarket(m.watchAddedAt, inst.currency).slice(0, 10);
  const usd = inst.currency === "USD";
  const fxAtAdd = usd ? at(inputs.fxSeries, addedOn) : 1;
  const fxNow = usd ? (inputs.fx?.usdInr ?? null) : 1;
  const skipped: PaperMemberRow["skipped"] =
    m.priceAtAdd == null || m.priceAtAdd <= 0 ? "no price at add" : inst.price == null ? "no price" : fxAtAdd == null || fxNow == null ? "no FX" : null;
  const returnPct = skipped ? null : (inst.price! * fxNow!) / (m.priceAtAdd! * fxAtAdd!) - 1;
  const days = daysBetween(addedOn, asOf);
  const row: PaperMemberRow = {
    id: m.id,
    kind: "paper",
    watchItemId: m.watchItemId,
    instrumentId: inst.id,
    symbol: inst.symbol,
    name: inst.name,
    market: inst.market,
    currency: inst.currency,
    addedOn,
    priceAtAdd: m.priceAtAdd,
    price: inst.price,
    returnPct,
    annualizedPct:
      returnPct != null && days >= 365
        ? annualizeOrAbsolute([
            { date: addedOn, amount: -1 },
            { date: asOf, amount: 1 + returnPct },
          ]).xirr
        : null,
    skipped,
    addedBy: displayAuthor(m.addedBy, actor, owner),
    canRemove: can(actor, "edit_own", { by: m.addedBy }),
  };
  const item = skipped
    ? null
    : { priceAtAdd: m.priceAtAdd!, addedAt: addedOn, price: inst.price!, fxAtAdd: fxAtAdd!, fxNow: fxNow! };
  return { row, item };
}

/** Investor-sign INR flows of real members, without the terminal value (price 0 → terminal 0, dropped). */
const flowsOf = (calcs: RealCalc[], asOf: ISODate): Flow[] =>
  calcs
    .flatMap((c) => positionPnl({ ...c.position, price: 0, asOf }).flows)
    .filter((f) => f.amountInr !== 0)
    .map((f) => ({ date: f.date, amount: f.amountInr }));

/**
 * Alpha on the basis the bucket's return is shown in: under 365 days, absolute return minus
 * the same flows' absolute return in the index; from 365 days, PME (or direct) alpha on XIRR.
 * Missing index or FX history for any flow date → "pending" (U17 backfills it).
 */
function alphaFor(market: Market, calcs: RealCalc[], index: IndexSeries | null, asOf: ISODate): Alpha {
  const label = BENCHMARK_LABEL[market];
  const flows = flowsOf(calcs, asOf);
  if (!flows.length) return { market, label, status: "na" };
  if (!index || !Object.keys(index.closes).length) return { market, label, status: "pending" };
  const terminal = { date: asOf, amount: calcs.reduce((s, c) => s + positionPnl({ ...c.position, asOf }).valueInr, 0) };
  try {
    const portfolio = annualizeOrAbsolute([...flows, terminal]);
    if (!portfolio.useAbsolute) {
      const r = benchmark(flows, terminal, index);
      return r.alpha == null
        ? { market, label, status: "na" }
        : { market, label, status: "ok", alpha: r.alpha, annualized: true, benchmarkReturn: r.benchmarkXirr };
    }
    const level = totalReturnIndex(index);
    const units = flows.reduce((u, f) => u - f.amount / level(f.date), 0);
    const bench = annualizeOrAbsolute([...flows, { date: asOf, amount: units * level(asOf) }]);
    if (portfolio.absolute == null || bench.absolute == null) return { market, label, status: "na" };
    return { market, label, status: "ok", alpha: portfolio.absolute - bench.absolute, annualized: false, benchmarkReturn: bench.absolute };
  } catch {
    // totalReturnIndex throws when no close/FX exists on or before a flow date.
    return { market, label, status: "pending" };
  }
}

const CHART_POINTS = 60;

/**
 * Value of the real members over time vs the same INR cash flows in the benchmark
 * (Nifty for India flows, S&P in INR for US flows). Both lines are "money still
 * invested": sales and dividends leave both. Past prices are raw closes scaled to the
 * lot's post-split basis; a day with no stored close falls back to the lot's cost.
 */
function buildChart(calcs: RealCalc[], inputs: BucketsInputs, asOf: ISODate, normalize: boolean): BucketChart | null {
  if (!calcs.length) return null;
  const start = calcs.reduce((m, c) => (c.m.lot.openDate < m ? c.m.lot.openDate : m), asOf);
  const span = daysBetween(start, asOf);
  if (span < 1) return null;
  const step = Math.max(1, Math.ceil(span / CHART_POINTS));
  const dates: ISODate[] = [];
  for (let i = 0; i < span; i += step) dates.push(new Date(Date.parse(start) + i * 86_400_000).toISOString().slice(0, 10));
  dates.push(asOf);

  const markets = (["IN", "US"] as const).filter((mk) => calcs.some((c) => c.inst.market === mk));
  let benchFns: { flows: Flow[]; level: (d: ISODate) => number }[] | null = [];
  try {
    for (const mk of markets) {
      const index = inputs.benchmarks[mk];
      if (!index || !Object.keys(index.closes).length) throw new Error("pending");
      const flows = flowsOf(calcs.filter((c) => c.inst.market === mk), asOf);
      const level = totalReturnIndex(index);
      for (const f of flows) level(f.date); // throws now if history doesn't reach a flow
      benchFns.push({ flows, level });
    }
  } catch {
    benchFns = null;
  }

  const moneyIn = calcs.reduce((s, c) => s + c.m.lot.qty * c.m.lot.costPerShare * c.m.lot.fxRateAtOpen, 0);
  const scale = normalize && moneyIn > 0 ? 100 / moneyIn : 1;

  const points = dates.map((d) => {
    let portfolio = 0;
    for (const { m, inst } of calcs)
      for (const lot of memberLots(m)) {
        if (lot.openDate > d) continue;
        const q = lot.qty - lot.closed.filter((c) => c.date <= d).reduce((s, c) => s + c.qty, 0);
        if (q <= 1e-9) continue;
        const close = d === asOf && inst.price != null ? inst.price : at(inst.closes, d);
        const px = close != null ? close / (d === asOf ? 1 : splitFactorAfter(inst, d)) : lot.costPerShare;
        const fx = inst.currency === "INR" ? 1 : ((d === asOf ? inputs.fx?.usdInr : null) ?? at(inputs.fxSeries, d) ?? lot.fxRateAtOpen);
        portfolio += q * px * fx;
      }
    const bench = benchFns
      ? benchFns.reduce((s, b) => s + b.flows.filter((f) => f.date <= d).reduce((u, f) => u - f.amount / b.level(f.date), 0) * b.level(d), 0)
      : null;
    return { date: d, portfolio: portfolio * scale, benchmark: bench == null ? null : bench * scale };
  });

  return {
    points,
    normalized: normalize,
    benchmarkPending: benchFns == null,
    benchmarkLabel: markets.map((mk) => BENCHMARK_LABEL[mk]).join(" + "),
  };
}

// ---------- pure builder ----------

function buildBucket(b: BucketInput, inputs: BucketsInputs, actor: Actor, asOf: ISODate, detail: boolean) {
  const owner = inputs.ownerEmail?.toLowerCase() ?? null;
  const mine = inputs.members.filter((m) => m.bucketId === b.id);
  const real = mine.flatMap((m) => (m.kind === "buy_event" ? [realCalc(m, inputs, asOf, actor, owner)] : []));
  const paper = mine.flatMap((m) => (m.kind === "watch_item" ? [paperCalc(m, inputs, asOf, actor, owner)] : []));
  const counted = real.filter((c) => c.included);

  const agg = aggregate({
    positions: counted.map((c) => c.position),
    paper: paper.flatMap((p) => (p.item ? [p.item] : [])),
    asOf,
  });
  const moneyIn = counted.reduce((s, c) => s + c.row.costInr, 0);
  const realMetrics: RealMetrics = {
    count: counted.length,
    open: counted.filter((c) => c.row.status !== "sold").length,
    sold: counted.filter((c) => c.row.status === "sold").length,
    unpriced: real.length - counted.length,
    costInr: agg.real.costInr,
    valueInr: agg.real.valueInr,
    realizedInr: agg.real.realizedInr,
    unrealizedInr: agg.real.unrealizedInr,
    dividendsNetInr: agg.real.dividendsNetInr,
    totalReturnInr: agg.real.totalReturnInr,
    realizedPct: ratio(agg.real.realizedInr, moneyIn),
    returnPct: agg.real.returns.absolute,
    xirr: agg.real.returns.xirr,
    useAbsolute: agg.real.returns.useAbsolute,
  };
  const markets = (["IN", "US"] as const).filter((mk) => counted.some((c) => c.inst.market === mk));

  const card: BucketCard = {
    id: b.id,
    name: b.name,
    description: b.description,
    color: b.color,
    createdBy: displayAuthor(b.createdBy, actor, owner),
    real: redactForActor(actor, realMetrics, BUCKET_REAL_POLICY),
    paper: {
      count: paper.filter((p) => p.item).length,
      skipped: paper.filter((p) => !p.item).length,
      returnPct: agg.paper.returns.absolute,
      annualizedPct: agg.paper.returns.xirr,
      useAbsolute: agg.paper.returns.useAbsolute,
    },
    combined: { returnPct: agg.combined.absolute, xirr: agg.combined.xirr, useAbsolute: agg.combined.useAbsolute },
    alpha: markets.map((mk) =>
      alphaFor(
        mk,
        counted.filter((c) => c.inst.market === mk),
        inputs.benchmarks[mk],
        asOf,
      ),
    ),
    canEdit: can(actor, "edit_own", { by: b.createdBy }),
    canArchive: can(actor, "delete_bucket"),
  };
  if (!detail) return { card };

  const inBucket = new Set(mine.map((m) => (m.kind === "buy_event" ? m.eventId : m.watchItemId)));
  const canAddMember = can(actor, "suggest");
  const detailView: BucketDetail = {
    ...card,
    amountsHidden: actor.hideAmounts,
    realMembers: real
      .map((c) => redactForActor(actor, c.row, MEMBER_POLICY))
      .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.boughtOn.localeCompare(b.boughtOn)),
    paperMembers: paper.map((p) => p.row).sort((a, b) => a.symbol.localeCompare(b.symbol)),
    chart: buildChart(counted, inputs, asOf, actor.hideAmounts),
    canAddMember,
    options: canAddMember
      ? {
          lots: (inputs.options?.lots ?? []).filter((o) => !inBucket.has(o.eventId)),
          watch: (inputs.options?.watch ?? []).filter((o) => !inBucket.has(o.watchItemId)),
        }
      : { lots: [], watch: [] },
  };
  return { card, detail: detailView };
}

const asOfFor = (now: Date) => isoInMarket(now, "INR").slice(0, 10);

/** Pure: inputs → bucket cards, redacted for the actor. */
export function buildBucketsView(inputs: BucketsInputs, actor: Actor): BucketsView {
  const asOf = asOfFor(inputs.now);
  return {
    amountsHidden: actor.hideAmounts,
    canCreate: can(actor, "create_bucket"),
    buckets: inputs.buckets.map((b) => buildBucket(b, inputs, actor, asOf, false).card),
  };
}

/** Pure: one bucket with its member rows, chart and add options. Null if not in inputs. */
export function buildBucketDetail(inputs: BucketsInputs, actor: Actor, id: string): BucketDetail | null {
  const b = inputs.buckets.find((x) => x.id === id);
  return b ? buildBucket(b, inputs, actor, asOfFor(inputs.now), true).detail! : null;
}

// ---------- loading ----------

/** India dividend TDS, settings key `india_dividend_tds` (a fraction); default 10%. */
export const INDIA_TDS_DEFAULT = 0.1;
const BENCHMARK_SYMBOL: Record<Market, string> = { IN: "NIFTYBEES.NS", US: "SPY" };

/** Dividend withholding per market: US treaty 25%; India TDS from settings `india_dividend_tds` (default 10%). */
export async function dividendWithholding(): Promise<Record<Market, number>> {
  const [row] = await db.select().from(settings).where(eq(settings.key, "india_dividend_tds"));
  const tds = Number(row?.value);
  return { IN: Number.isFinite(tds) && tds >= 0 && tds < 1 ? tds : INDIA_TDS_DEFAULT, US: US_DIVIDEND_WITHHOLDING };
}

async function loadIndex(symbol: string, since: ISODate, withholdingRate: number, fx?: PriceSeries): Promise<IndexSeries | null> {
  const [inst] = await db.select({ id: instruments.id }).from(instruments).where(eq(instruments.yahooSymbol, symbol));
  if (!inst) return null;
  const [closes, divs, acts] = await Promise.all([
    db
      .select({ date: pricesDaily.date, close: pricesDaily.close })
      .from(pricesDaily)
      .where(and(eq(pricesDaily.instrumentId, inst.id), gte(pricesDaily.date, since))),
    db.select().from(dividends).where(and(eq(dividends.instrumentId, inst.id), gte(dividends.exDate, since))),
    db.select().from(corporateActions).where(and(eq(corporateActions.instrumentId, inst.id), gte(corporateActions.exDate, since))),
  ]);
  if (!closes.length) return null;
  return {
    closes: Object.fromEntries(closes.map((c) => [c.date, Number(c.close)])),
    dividends: divs.map((d) => ({ exDate: d.exDate, perShareGross: Number(d.amountPerShare) })),
    splits: acts.filter((a) => a.kind === "split").map((a) => ({ exDate: a.exDate, ratio: Number(a.numerator) / Number(a.denominator) })),
    fx,
    withholdingRate,
  };
}

/**
 * Loads live buckets (one, for the detail page) with members on LIVE events only: rows
 * left on a superseded event are history, their copies sit on the replacing events.
 */
export async function loadBucketsInputs(now: Date, opts: { bucketId?: string; detail?: boolean } = {}): Promise<BucketsInputs> {
  const bucketRows = await db
    .select()
    .from(buckets)
    .where(and(isNull(buckets.archivedAt), opts.bucketId ? eq(buckets.id, opts.bucketId) : undefined))
    .orderBy(buckets.createdAt);
  const memberRows = bucketRows.length
    ? await db
        .select({ m: bucketMembers, w: watchItems, e: { instrumentId: ledgerEvents.instrumentId } })
        .from(bucketMembers)
        .leftJoin(watchItems, eq(watchItems.id, bucketMembers.watchItemId))
        .leftJoin(ledgerEvents, eq(ledgerEvents.id, bucketMembers.buyEventId))
        .where(inArray(bucketMembers.bucketId, bucketRows.map((b) => b.id)))
    : [];

  const [fxRows, withholding] = await Promise.all([db.select().from(fxDaily), dividendWithholding()]);
  const fxSeries: PriceSeries = Object.fromEntries(fxRows.map((r) => [r.date, Number(r.usdInr)]));
  const lastFx = fxRows.reduce<(typeof fxRows)[number] | null>((m, r) => (!m || r.date > m.date ? r : m), null);

  // Detail pages also list what can be added: every open buy lot and active watch item.
  const ledgerScope = opts.detail
    ? undefined
    : [...new Set(memberRows.flatMap((r) => (r.e?.instrumentId ? [r.e.instrumentId] : [])))];
  const ledger = await loadLedger(db, ledgerScope);
  const live = liveEvents(ledger.events, ledger.supersessions);
  const liveIds = new Set(live.map((e) => e.id));
  const byId = new Map(ledger.events.map((e) => [e.id, e]));
  const r = replay(ledger.events, ledger.supersessions);
  const allLots = [...r.openLots, ...r.closedLots];
  const lotByEvent = new Map(allLots.map((l) => [l.eventId, l]));
  const bonuses = live.filter((e) => e.type === "bonus").map((e) => ({ eventId: e.id, instrumentId: e.instrumentId, exDate: effDate(e) }));

  const members: MemberInput[] = [];
  for (const { m, w, e } of memberRows) {
    if (m.memberType === "buy_event") {
      const lot = lotByEvent.get(m.buyEventId!);
      if (!e || !liveIds.has(m.buyEventId!) || !lot) continue;
      members.push({
        kind: "buy_event",
        id: m.id,
        bucketId: m.bucketId,
        addedBy: m.addedBy,
        instrumentId: e.instrumentId,
        eventId: m.buyEventId!,
        lot,
        approximate: byId.get(m.buyEventId!)?.approximate ?? false,
        bonusLots: bonusSlices(
          lot,
          allLots.filter((l) => l.instrumentId === e.instrumentId),
          bonuses.filter((b) => b.instrumentId === e.instrumentId),
        ),
      });
    } else if (w) {
      members.push({
        kind: "watch_item",
        id: m.id,
        bucketId: m.bucketId,
        addedBy: m.addedBy,
        instrumentId: w.instrumentId,
        watchItemId: w.id,
        priceAtAdd: w.priceAtAdd == null ? null : Number(w.priceAtAdd),
        watchAddedAt: w.addedAt,
      });
    }
  }

  const watchOpts = opts.detail
    ? await db
        .select({ w: watchItems, i: instruments })
        .from(watchItems)
        .innerJoin(instruments, eq(instruments.id, watchItems.instrumentId))
        .where(isNull(watchItems.archivedAt))
    : [];
  const lotOpts = opts.detail ? r.openLots.filter((l) => (MEMBER_EVENT_TYPES as readonly string[]).includes(byId.get(l.eventId)?.type ?? "")) : [];

  const instrumentIds = [...new Set([...members.map((m) => m.instrumentId), ...lotOpts.map((l) => l.instrumentId)])];
  const instRows = instrumentIds.length
    ? await db
        .select({ i: instruments, p: priceLatest })
        .from(instruments)
        .leftJoin(priceLatest, eq(priceLatest.instrumentId, instruments.id))
        .where(inArray(instruments.id, instrumentIds))
    : [];
  const since = members.reduce<ISODate>((s, m) => {
    const d = m.kind === "buy_event" ? m.lot.openDate : isoInMarket(m.watchAddedAt, "INR").slice(0, 10);
    return d < s ? d : s;
  }, asOfFor(now));
  const lookback = new Date(Date.parse(since) - 10 * 86_400_000).toISOString().slice(0, 10);
  const memberInstIds = [...new Set(members.map((m) => m.instrumentId))];
  const [divRows, closeRows, IN, US] = await Promise.all([
    memberInstIds.length ? db.select().from(dividends).where(inArray(dividends.instrumentId, memberInstIds)) : [],
    opts.detail && memberInstIds.length
      ? db
          .select({ id: pricesDaily.instrumentId, date: pricesDaily.date, close: pricesDaily.close })
          .from(pricesDaily)
          .where(and(inArray(pricesDaily.instrumentId, memberInstIds), gte(pricesDaily.date, lookback)))
      : [],
    loadIndex(BENCHMARK_SYMBOL.IN, lookback, withholding.IN),
    loadIndex(BENCHMARK_SYMBOL.US, lookback, withholding.US, fxSeries),
  ]);

  const instrumentsMap: Record<string, InstrumentInput> = {};
  for (const { i, p } of instRows) {
    const closes = closeRows.filter((c) => c.id === i.id);
    instrumentsMap[i.id] = {
      id: i.id,
      symbol: i.brokerSymbol,
      name: i.name,
      market: i.market,
      currency: i.currency,
      price: p && !i.priceUnavailable ? Number(p.price) : null,
      dividends: divRows
        .filter((d) => d.instrumentId === i.id)
        .flatMap((d) => {
          const fxRate = d.currency === "INR" ? 1 : at(fxSeries, d.payDate ?? d.exDate);
          return fxRate == null
            ? []
            : [{ exDate: d.exDate, payDate: d.payDate ?? undefined, perShareGross: Number(d.amountPerShare), currency: d.currency, fxRate }];
        }),
      splits: live
        .filter((e) => e.instrumentId === i.id && e.type === "split" && e.ratio)
        .map((e) => ({ exDate: effDate(e), ratio: e.ratio!.num / e.ratio!.den })),
      closes: opts.detail ? Object.fromEntries(closes.map((c) => [c.date, Number(c.close)])) : undefined,
    };
  }

  return {
    now,
    ownerEmail: process.env.OWNER_EMAIL ?? null,
    buckets: bucketRows.map((b) => ({
      id: b.id,
      name: b.name,
      description: b.description,
      color: b.color as BucketColor,
      createdBy: b.createdBy,
    })),
    members,
    instruments: instrumentsMap,
    fx: lastFx ? { usdInr: Number(lastFx.usdInr), date: lastFx.date } : null,
    fxSeries,
    benchmarks: { IN, US },
    withholding,
    options: opts.detail
      ? {
          lots: lotOpts
            .map((l) => {
              const i = instrumentsMap[l.instrumentId];
              return {
                eventId: l.eventId,
                instrumentId: l.instrumentId,
                symbol: i.symbol,
                name: i.name,
                market: i.market,
                currency: i.currency,
                boughtOn: l.openDate,
                price: l.costPerShare,
              };
            })
            .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.boughtOn.localeCompare(b.boughtOn)),
          watch: watchOpts
            .map(({ w, i }) => ({
              watchItemId: w.id,
              instrumentId: i.id,
              symbol: i.brokerSymbol,
              name: i.name,
              market: i.market,
              addedOn: isoInMarket(w.addedAt, i.currency).slice(0, 10),
            }))
            .sort((a, b) => a.symbol.localeCompare(b.symbol)),
        }
      : undefined,
  };
}

export async function getBucketsView(): Promise<BucketsView> {
  const actor = await requireActor();
  return buildBucketsView(await loadBucketsInputs(new Date()), actor);
}

export async function getBucketDetailView(id: string): Promise<BucketDetail | null> {
  const actor = await requireActor();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  return buildBucketDetail(await loadBucketsInputs(new Date(), { bucketId: id, detail: true }), actor, id);
}

// ---------- membership lookups for holdings and watchlist ----------

export type BucketChip = { id: string; name: string; color: BucketColor };

/** Live buckets, by name (filter tabs, pickers). */
export async function listBuckets(): Promise<BucketChip[]> {
  const rows = await db
    .select({ id: buckets.id, name: buckets.name, color: buckets.color })
    .from(buckets)
    .where(isNull(buckets.archivedAt))
    .orderBy(buckets.name);
  return rows.map((r) => ({ ...r, color: r.color as BucketColor }));
}

/** Live bucket ids per buy event / watch item id. */
export async function bucketIdsFor(ref: "buy_event" | "watch_item", ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!ids.length) return out;
  const col = ref === "buy_event" ? bucketMembers.buyEventId : bucketMembers.watchItemId;
  const rows = await db
    .select({ ref: col, bucketId: bucketMembers.bucketId })
    .from(bucketMembers)
    .innerJoin(buckets, and(eq(buckets.id, bucketMembers.bucketId), isNull(buckets.archivedAt)))
    .where(inArray(col, ids));
  for (const r of rows) out.set(r.ref!, [...(out.get(r.ref!) ?? []), r.bucketId]);
  return out;
}
