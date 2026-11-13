// Server-only view module (convention: never import from a client component).
// getHoldingsView() resolves the actor itself (DAL rule), loads snapshots + ledger +
// prices + FX, and hands them to the pure buildHoldingsView(), which does the math and
// the hide-amounts redaction. Pages render the DTO; they never touch the DB.
import { and, desc, eq, gte, inArray, notLike, sql } from "drizzle-orm";
import { db } from "@/db";
import { fxDaily, holdingSnapshots, instruments, priceLatest, pricesDaily, syncRuns } from "@/db/schema";
import { type Actor, requireActor } from "@/lib/auth/access";
import { type FieldPolicy, type Redacted, redactForActor } from "@/lib/auth/redact";
import { replay } from "@/lib/ledger/lots";
import { isoInMarket, loadLedger } from "@/lib/ledger/queries";
import { ensureFresh } from "@/lib/market/live";
import { fxReturns } from "@/lib/returns/fx-returns";
import { positionPnl } from "@/lib/returns/pnl";
import { ltcgEligibleDate } from "@/lib/returns/tax";
import type { Currency, ISODate, Lot, Market } from "@/lib/returns/types";
import { type BucketChip, bucketIdsFor, listBuckets } from "./buckets";

export type PriceSource = "yahoo" | "mcp" | "broker";

export interface HoldingInput {
  instrumentId: string;
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  exchange: string;
  priceUnavailable: boolean;
  snapshot: { qty: number; t1Qty: number; avgPrice: number; ltp: number | null; takenAt: Date };
  /** Open ledger lots; `approximate` comes from the event that opened the lot. */
  lots: (Lot & { approximate: boolean })[];
  /** `prevClose`: price_latest's previous-session close, aligned with `asOf` by its writers. */
  price: { price: number; asOf: Date; source: PriceSource; prevClose?: number | null } | null;
  /** Recent daily closes (any order); the previous close is picked relative to the price date. */
  closes: { date: ISODate; close: number }[];
  /** Buckets of any open lot's buy event (U15): a holding is in a bucket if any open lot is. */
  bucketIds?: string[];
}

export interface HoldingsInputs {
  holdings: HoldingInput[];
  /** Live buckets (filter tabs). */
  buckets?: BucketChip[];
  fx: { usdInr: number; date: ISODate } | null;
  now: Date;
}

export interface HoldingRow {
  instrumentId: string;
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  exchange: string;
  qty: number;
  t1Qty: number;
  /** Native currency, open FIFO lots. A price, not an amount. */
  avgCost: number | null;
  price: number | null;
  priceAsOf: string | null;
  priceSource: PriceSource | null;
  /** No usable price: excluded from every total. */
  unpriced: boolean;
  investedNative: number;
  investedInr: number | null;
  valueNative: number | null;
  valueInr: number | null;
  pnlNative: number | null;
  pnlInr: number | null;
  dayChangeNative: number | null;
  dayChangeInr: number | null;
  /** Native-currency return (USD for US rows). */
  returnPct: number | null;
  returnInrPct: number | null;
  /** US only: INR return − USD return. */
  fxContributionPct: number | null;
  dayChangePct: number | null;
  /** Share of the combined INR value of priced holdings. */
  weightPct: number | null;
  heldSince: ISODate;
  heldDays: number;
  /** All open lots long-term → "LTCG"; else days until the next lot crosses. */
  ltcg: { allLongTerm: boolean; nextEligible: ISODate | null; daysToNext: number | null };
  t1: boolean;
  approximate: boolean;
  bucketIds: string[];
}

export interface Totals {
  count: number;
  pricedCount: number;
  valueInr: number;
  investedInr: number;
  pnlInr: number;
  returnPct: number | null;
  dayChangeInr: number;
  dayChangePct: number | null;
  /** US section only. */
  valueUsd?: number;
  investedUsd?: number;
  pnlUsd?: number;
  returnUsdPct?: number | null;
  fxContributionPct?: number | null;
  /** Newest price timestamp among the rows. */
  priceAsOf: string | null;
}

export const HOLDING_POLICY = [
  "qty",
  "t1Qty",
  "investedNative",
  "investedInr",
  "valueNative",
  "valueInr",
  "pnlNative",
  "pnlInr",
  "dayChangeNative",
  "dayChangeInr",
] as const satisfies FieldPolicy<HoldingRow>;

export const TOTALS_POLICY = [
  "valueInr",
  "investedInr",
  "pnlInr",
  "dayChangeInr",
  "valueUsd",
  "investedUsd",
  "pnlUsd",
] as const satisfies FieldPolicy<Totals>;

export type HoldingRowDto = Redacted<HoldingRow, (typeof HOLDING_POLICY)[number]>;
export type TotalsDto = Redacted<Totals, (typeof TOTALS_POLICY)[number]>;
export type AllocationSlice = { key: string; label: string; weightPct: number };

export interface HoldingsView {
  empty: boolean;
  amountsHidden: boolean;
  rows: HoldingRowDto[];
  totals: { all: TotalsDto; IN: TotalsDto; US: TotalsDto };
  allocation: AllocationSlice[];
  flags: { approximate: number; unpriced: number; t1: number };
  fx: { usdInr: number; date: ISODate } | null;
  /** Live buckets with how many holdings each contains. */
  buckets: (BucketChip & { count: number })[];
  /** Freshest price timestamp across all rows ("Live · updated 12:41:03"). */
  priceAsOf: string | null;
}

const DAY_MS = 86_400_000;
const daysBetween = (a: ISODate, b: ISODate) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
const openQty = (l: Lot) => l.qty - l.closed.reduce((s, c) => s + c.qty, 0);
const ratio = (num: number, den: number) => (den > 0 ? num / den - 1 : null);
export const ALLOCATION_TOP_N = 6;

function buildRow(h: HoldingInput, fxNow: number | null, now: Date): HoldingRow {
  const today = isoInMarket(now, h.currency).slice(0, 10);
  const fx = h.currency === "INR" ? 1 : fxNow;
  // No ledger lots yet (sync ran, ingest didn't): fall back to the broker's avg, flagged approximate.
  const lots: HoldingInput["lots"] = h.lots.length
    ? h.lots
    : [
        {
          instrumentId: h.instrumentId,
          market: h.market,
          currency: h.currency,
          qty: h.snapshot.qty,
          costPerShare: h.snapshot.avgPrice,
          openDate: isoInMarket(h.snapshot.takenAt, h.currency).slice(0, 10),
          fxRateAtOpen: fx ?? 0,
          closed: [],
          approximate: true,
        },
      ];

  const quote: { price: number; asOf: string; source: PriceSource } | null = h.price
    ? { price: h.price.price, asOf: h.price.asOf.toISOString(), source: h.price.source }
    : h.snapshot.ltp != null && !h.priceUnavailable
      ? { price: h.snapshot.ltp, asOf: h.snapshot.takenAt.toISOString(), source: "broker" }
      : null;
  const unpriced = !quote || fx == null;

  const p = positionPnl({ lots, price: quote?.price ?? 0, fxNow: fx ?? 0, asOf: today });
  const qty = p.openQty;

  // Previous close: price_latest.prev_close when the quote came from there (stored with the price),
  // else the newest daily close strictly before the price's market date.
  const priceDate = quote ? isoInMarket(new Date(quote.asOf), h.currency).slice(0, 10) : today;
  const stored = h.price?.prevClose;
  const prev =
    h.price && stored != null && stored > 0
      ? { close: stored }
      : h.closes.filter((c) => c.date < priceDate).sort((a, b) => b.date.localeCompare(a.date))[0];
  // ponytail: a split between prev close and today makes this jump; adjust by corporate actions if it bites.
  const dayChangeNative = quote && prev ? qty * (quote.price - prev.close) : null;

  const open = lots.filter((l) => openQty(l) > 1e-9);
  const heldSince = open.reduce((m, l) => (l.openDate < m ? l.openDate : m), open[0]?.openDate ?? today);
  const pending = open
    .map((l) => ltcgEligibleDate(l.openDate, h.market))
    .filter((d) => d > today)
    .sort();
  const fxr = unpriced ? null : fxReturns(p);

  return {
    instrumentId: h.instrumentId,
    symbol: h.symbol,
    name: h.name,
    market: h.market,
    currency: h.currency,
    exchange: h.exchange,
    qty,
    t1Qty: h.snapshot.t1Qty,
    avgCost: qty > 0 ? p.costNative / qty : null,
    price: quote?.price ?? null,
    priceAsOf: quote?.asOf ?? null,
    priceSource: quote?.source ?? null,
    unpriced,
    investedNative: p.costNative,
    investedInr: fx == null ? null : p.costInr,
    valueNative: quote ? p.valueNative : null,
    valueInr: unpriced ? null : p.valueInr,
    pnlNative: quote ? p.unrealizedNative : null,
    pnlInr: unpriced ? null : p.unrealizedInr,
    dayChangeNative,
    dayChangeInr: dayChangeNative != null && fx != null ? dayChangeNative * fx : null,
    returnPct: quote ? ratio(p.valueNative, p.costNative) : null,
    returnInrPct: fxr?.inrReturn ?? null,
    fxContributionPct: h.currency === "USD" ? (fxr?.fxContribution ?? null) : null,
    dayChangePct: quote && prev ? ratio(quote.price, prev.close) : null,
    weightPct: null,
    heldSince,
    heldDays: Math.max(0, daysBetween(heldSince, today)),
    ltcg: {
      allLongTerm: pending.length === 0,
      nextEligible: pending[0] ?? null,
      daysToNext: pending[0] ? daysBetween(today, pending[0]) : null,
    },
    t1: h.snapshot.t1Qty > 0,
    approximate: lots.some((l) => l.approximate && openQty(l) > 1e-9),
    bucketIds: h.bucketIds ?? [],
  };
}

function sumTotals(rows: HoldingRow[], usd: boolean): Totals {
  const priced = rows.filter((r) => !r.unpriced);
  const sum = (f: (r: HoldingRow) => number | null, rs = priced) => rs.reduce((s, r) => s + (f(r) ?? 0), 0);
  const valueInr = sum((r) => r.valueInr);
  const investedInr = sum((r) => r.investedInr);
  const withPrev = priced.filter((r) => r.dayChangeInr != null);
  const dayChangeInr = sum((r) => r.dayChangeInr, withPrev);
  const prevValue = sum((r) => r.valueInr, withPrev) - dayChangeInr;
  const asOf = rows.map((r) => r.priceAsOf).filter((d): d is string => !!d).sort().at(-1) ?? null;
  const t: Totals = {
    count: rows.length,
    pricedCount: priced.length,
    valueInr,
    investedInr,
    pnlInr: valueInr - investedInr,
    returnPct: ratio(valueInr, investedInr),
    dayChangeInr,
    dayChangePct: withPrev.length ? ratio(prevValue + dayChangeInr, prevValue) : null,
    priceAsOf: asOf,
  };
  if (usd) {
    const valueUsd = sum((r) => r.valueNative);
    const investedUsd = sum((r) => r.investedNative);
    const fxr = fxReturns({ costNative: investedUsd, costInr: investedInr, valueNative: valueUsd, valueInr });
    Object.assign(t, {
      valueUsd,
      investedUsd,
      pnlUsd: valueUsd - investedUsd,
      returnUsdPct: fxr.nativeReturn,
      fxContributionPct: fxr.fxContribution,
    });
  }
  return t;
}

/** Pure: inputs → DTO, redacted for the actor. Empty inputs give an empty view, never an error. */
export function buildHoldingsView(inputs: HoldingsInputs, actor: Actor): HoldingsView {
  const fxNow = inputs.fx?.usdInr ?? null;
  const rows = inputs.holdings.map((h) => buildRow(h, fxNow, inputs.now));
  const all = sumTotals(rows, false);
  for (const r of rows) r.weightPct = r.valueInr != null && all.valueInr > 0 ? r.valueInr / all.valueInr : null;
  rows.sort((a, b) => (b.weightPct ?? -1) - (a.weightPct ?? -1));

  const ranked = rows.filter((r) => (r.weightPct ?? 0) > 0);
  const allocation: AllocationSlice[] = ranked
    .slice(0, ALLOCATION_TOP_N)
    .map((r) => ({ key: r.instrumentId, label: r.symbol, weightPct: r.weightPct! }));
  const rest = ranked.slice(ALLOCATION_TOP_N).reduce((s, r) => s + r.weightPct!, 0);
  if (rest > 0) allocation.push({ key: "other", label: "Other", weightPct: rest });

  const totals = {
    all,
    IN: sumTotals(
      rows.filter((r) => r.market === "IN"),
      false,
    ),
    US: sumTotals(
      rows.filter((r) => r.market === "US"),
      true,
    ),
  };
  return {
    empty: rows.length === 0,
    amountsHidden: actor.hideAmounts,
    rows: rows.map((r) => redactForActor(actor, r, HOLDING_POLICY)),
    totals: {
      all: redactForActor(actor, totals.all, TOTALS_POLICY),
      IN: redactForActor(actor, totals.IN, TOTALS_POLICY),
      US: redactForActor(actor, totals.US, TOTALS_POLICY),
    },
    allocation,
    flags: {
      approximate: rows.filter((r) => r.approximate).length,
      unpriced: rows.filter((r) => r.unpriced).length,
      t1: rows.filter((r) => r.t1).length,
    },
    fx: inputs.fx,
    buckets: (inputs.buckets ?? []).map((b) => ({ ...b, count: rows.filter((r) => r.bucketIds.includes(b.id)).length })),
    priceAsOf: totals.all.priceAsOf,
  };
}

const num = (s: string | null) => (s == null ? null : Number(s));

/** The latest completed snapshot run per broker: its rows with qty > 0 are what is held now. */
export async function latestSnapshotRunIds(): Promise<string[]> {
  const rows = await db
    .selectDistinctOn([holdingSnapshots.broker], { broker: holdingSnapshots.broker, runId: holdingSnapshots.runId })
    .from(holdingSnapshots)
    // Test runs (job "test-…") share the prod database; they must never become the visible portfolio.
    .innerJoin(
      syncRuns,
      and(eq(syncRuns.id, holdingSnapshots.runId), eq(syncRuns.status, "completed"), notLike(syncRuns.job, "test-%")),
    )
    .orderBy(holdingSnapshots.broker, desc(holdingSnapshots.takenAt));
  return rows.map((r) => r.runId);
}

/** Latest completed snapshot run per broker → open holdings, with ledger lots, prices and FX. */
export async function loadHoldingsInputs(now: Date): Promise<HoldingsInputs> {
  const latestRuns = await latestSnapshotRunIds();
  const [fxRow] = await db.select().from(fxDaily).orderBy(desc(fxDaily.date)).limit(1);
  const fx = fxRow ? { usdInr: Number(fxRow.usdInr), date: fxRow.date } : null;
  if (!latestRuns.length) return { holdings: [], fx, now };

  const snaps = await db
    .select({ s: holdingSnapshots, i: instruments, p: priceLatest })
    .from(holdingSnapshots)
    .innerJoin(instruments, eq(instruments.id, holdingSnapshots.instrumentId))
    .leftJoin(priceLatest, eq(priceLatest.instrumentId, holdingSnapshots.instrumentId))
    .where(
      and(
        inArray(holdingSnapshots.runId, latestRuns),
        sql`${holdingSnapshots.qty} > 0`,
      ),
    );
  const ids = snaps.map((r) => r.s.instrumentId);
  if (!ids.length) return { holdings: [], fx, now };

  const since = new Date(now.getTime() - 14 * DAY_MS).toISOString().slice(0, 10);
  const [ledger, closes] = await Promise.all([
    loadLedger(db, ids),
    db
      .select({ id: pricesDaily.instrumentId, date: pricesDaily.date, close: pricesDaily.close })
      .from(pricesDaily)
      .where(and(inArray(pricesDaily.instrumentId, ids), gte(pricesDaily.date, since))),
  ]);
  const approx = new Map(ledger.events.map((e) => [e.id, e.approximate]));
  const { openLots } = replay(ledger.events, ledger.supersessions);
  const [inBuckets, bucketList] = await Promise.all([bucketIdsFor("buy_event", openLots.map((l) => l.eventId)), listBuckets()]);

  return {
    fx,
    now,
    buckets: bucketList,
    holdings: snaps.map(({ s, i, p }) => ({
      instrumentId: i.id,
      symbol: i.brokerSymbol,
      name: i.name,
      market: i.market,
      currency: i.currency,
      exchange: i.exchange,
      priceUnavailable: i.priceUnavailable,
      snapshot: {
        qty: Number(s.qty),
        t1Qty: Number(s.t1Qty),
        avgPrice: Number(s.avgPrice),
        ltp: num(s.ltp),
        takenAt: s.takenAt,
      },
      lots: openLots
        .filter((l) => l.instrumentId === i.id)
        .map((l) => ({ ...l, approximate: approx.get(l.eventId) ?? false })),
      price:
        p && !i.priceUnavailable
          ? { price: Number(p.price), asOf: p.asOf, source: p.source, prevClose: num(p.prevClose) }
          : null,
      closes: closes.filter((c) => c.id === i.id).map((c) => ({ date: c.date, close: Number(c.close) })),
      bucketIds: [
        ...new Set(openLots.filter((l) => l.instrumentId === i.id).flatMap((l) => inBuckets.get(l.eventId) ?? [])),
      ],
    })),
  };
}

/** Instruments in the latest completed snapshot runs with qty > 0. */
async function heldInstruments() {
  const runs = await latestSnapshotRunIds();
  if (!runs.length) return [];
  const held = db
    .select({ id: holdingSnapshots.instrumentId })
    .from(holdingSnapshots)
    .where(and(inArray(holdingSnapshots.runId, runs), sql`${holdingSnapshots.qty} > 0`));
  return db.select().from(instruments).where(inArray(instruments.id, held));
}

export async function getHoldingsView(): Promise<HoldingsView> {
  const actor = await requireActor();
  // Live prices are best-effort: a failure leaves the stored prices and never fails the page.
  await heldInstruments()
    .then((list) => ensureFresh(list))
    .catch((e) => console.error("[holdings] live price refresh failed", e));
  return buildHoldingsView(await loadHoldingsInputs(new Date()), actor);
}
