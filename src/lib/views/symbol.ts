// Server-only view module for the symbol page (U19). getSymbolView() resolves the actor,
// loads one instrument's raw closes, corporate actions, live ledger trades, open lots,
// watch items and targets, and hands them to the pure buildSymbolView().
//
// Chart basis: prices_daily is RAW, so every close, trade, watch price and target level is
// divided by the cumulative factor of corporate actions AFTER its own date. The whole chart
// is then on today's share basis (a pre-split buy sits where the post-split line was).
//
// Redaction: lots drop qty and cost (dates and % only, per U19), markers drop qty, and the
// position drops qty. Prices of the instrument itself (LTP, avg cost) stay, as on Holdings.
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { corporateActions, holdingSnapshots, instruments, priceLatest, pricesDaily, watchItems } from "@/db/schema";
import { type Actor, requireActor } from "@/lib/auth/access";
import { type FieldPolicy, type Redacted, redactForActor } from "@/lib/auth/redact";
import { liveEvents, openQty, replay } from "@/lib/ledger/lots";
import { isoInMarket, loadLedger } from "@/lib/ledger/queries";
import { CAP_LABEL, type CapThresholds, capBucket } from "@/lib/market/market-cap";
import { ltcgEligibleDate } from "@/lib/returns/tax";
import type { Currency, ISODate, Lot, Market } from "@/lib/returns/types";
import { daysBetween } from "@/lib/returns/xirr";
import { loadPreferences } from "@/lib/settings/preferences";
import { factorAfter } from "@/lib/targets/evaluate";
import { type BucketChip, bucketIdsFor, listBuckets } from "./buckets";
import { latestSnapshotRunIds } from "./holdings";
import { buildTargetsView, loadTargetsInputs, nearestMarks, type TargetRow } from "./targets";

export const RANGES = { "1m": 30, "6m": 182, "1y": 365, "5y": 1826, max: null } as const;
export type RangeKey = keyof typeof RANGES;
export const DEFAULT_RANGE: RangeKey = "1y";
export const parseRange = (v: unknown): RangeKey => (typeof v === "string" && v in RANGES ? (v as RangeKey) : DEFAULT_RANGE);

export interface SymbolInstrument {
  id: string;
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  exchange: string;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  priceUnavailable: boolean;
}

export interface SymbolInputs {
  instrument: SymbolInstrument;
  price: { price: number; asOf: Date; source: "yahoo" | "mcp" | "broker" } | null;
  /** Raw daily closes from `since` (any order). */
  bars: { date: ISODate; close: number }[];
  /** Every corporate action of the instrument (split and bonus both change the per-share basis). */
  actions: { exDate: ISODate; ratio: number }[];
  /** Live buy/sell/opening events, on the raw basis of their own date. */
  trades: { id: string; type: "buy" | "sell" | "opening"; date: ISODate; qty: number; price: number; approximate: boolean }[];
  /** Open lots after replay (ledger basis = today's), with the approximate flag of their event. */
  lots: (Lot & { eventId: string; approximate: boolean; bonus: boolean })[];
  /** Latest broker snapshot (Kite/INDmoney weighted average), when held. */
  snapshot: { qty: number; avgPrice: number; takenAt: Date } | null;
  watch: { id: string; addedAt: Date; priceAtAdd: number | null; archived: boolean }[];
  /** Active (pending) targets as built by buildTargetsView: `price` already on today's basis, `setPrice` the stored level. */
  activeTargets: TargetRow[];
  bucketsByEvent: Record<string, BucketChip[]>;
  capThresholds: CapThresholds;
  range: RangeKey;
  now: Date;
}

export type MarkerKind = "buy" | "sell" | "watch";
export interface Marker {
  kind: MarkerKind;
  date: ISODate;
  /** UTC ms of the date (chart x). */
  t: number;
  /** Today's basis. */
  price: number;
  /** Today's basis. Amount: redacted for hide-amounts. */
  qty: number | null;
  approximate: boolean;
  label: string;
}
export const MARKER_POLICY = ["qty"] as const satisfies FieldPolicy<Marker>;

export interface LotRow {
  eventId: string;
  openDate: ISODate;
  qty: number;
  costPerShare: number;
  invested: number;
  /** This lot's share of the open position. */
  sharePct: number;
  /** price / cost − 1; null for a zero-cost bonus lot or without a price. */
  returnPct: number | null;
  ltcgDate: ISODate;
  longTerm: boolean;
  daysToLtcg: number;
  approximate: boolean;
  bonus: boolean;
  buckets: BucketChip[];
}
export const LOT_POLICY = ["qty", "costPerShare", "invested"] as const satisfies FieldPolicy<LotRow>;
export type LotRowDto = Redacted<LotRow, (typeof LOT_POLICY)[number]>;

export interface Position {
  qty: number;
  /** FIFO average of the open lots. A price. */
  avgCost: number;
  /** The broker's weighted average from the latest snapshot (what the Kite app shows). */
  brokerAvg: number | null;
  returnPct: number | null;
  lots: LotRowDto[];
  /** Union of the lots' buckets. */
  buckets: BucketChip[];
}
export const POSITION_POLICY = ["qty"] as const satisfies FieldPolicy<Position>;

export interface SymbolView {
  amountsHidden: boolean;
  instrument: SymbolInstrument & { capLabel: string | null };
  quote: { price: number; asOf: string; source: "yahoo" | "mcp" | "broker" | "close"; dayChangePct: number | null } | null;
  chart: {
    range: RangeKey;
    points: { t: number; date: ISODate; close: number }[];
    markers: Redacted<Marker, "qty">[];
    levels: { kind: "target" | "stop"; price: number }[];
    /** Corporate actions inside the shown range, for the "adjusted for" note. */
    adjustedFor: { exDate: ISODate; ratio: number }[];
    high: { date: ISODate; close: number } | null;
    low: { date: ISODate; close: number } | null;
    changePct: number | null;
  };
  position: Redacted<Position, "qty"> | null;
  /** Pending targets as buildTargetsView adjusts them (`price` on today's basis, `setPrice` when a split moved it). */
  targets: TargetRow[];
}

const DAY_MS = 86_400_000;
const MAX_POINTS = 600;
const tOf = (d: ISODate) => Date.parse(`${d}T00:00:00Z`);

export function rangeStart(range: RangeKey, today: ISODate): ISODate | null {
  const days = RANGES[range];
  return days == null ? null : new Date(tOf(today) - days * DAY_MS).toISOString().slice(0, 10);
}

/** Pure: inputs → DTO, redacted for the actor. */
export function buildSymbolView(inputs: SymbolInputs, actor: Actor): SymbolView {
  const { instrument: inst, actions } = inputs;
  const today = isoInMarket(inputs.now, inst.currency).slice(0, 10);
  const adj = (raw: number, date: ISODate) => raw / factorAfter(date, actions);

  const all = inputs.bars
    .map((b) => ({ t: tOf(b.date), date: b.date, close: adj(b.close, b.date) }))
    .sort((a, b) => a.t - b.t);
  const start = rangeStart(inputs.range, today);
  const shown = start ? all.filter((p) => p.date >= start) : all;
  const from = start ?? shown[0]?.date ?? today;
  // ponytail: plain every-nth sampling above 600 points (keeps the last bar); min/max-preserving downsampling if spikes go missing.
  const step = Math.ceil(shown.length / MAX_POINTS);
  const points = step > 1 ? shown.filter((_, i) => i % step === 0 || i === shown.length - 1) : shown;
  const high = shown.reduce<(typeof shown)[number] | null>((m, p) => (!m || p.close > m.close ? p : m), null);
  const low = shown.reduce<(typeof shown)[number] | null>((m, p) => (!m || p.close < m.close ? p : m), null);

  const quote = inputs.price
    ? { price: inputs.price.price, asOf: inputs.price.asOf.toISOString(), source: inputs.price.source }
    : all.length && !inst.priceUnavailable
      ? { price: all.at(-1)!.close, asOf: `${all.at(-1)!.date}T00:00:00.000Z`, source: "close" as const }
      : null;
  const quoteDate = quote ? (quote.source === "close" ? quote.asOf.slice(0, 10) : isoInMarket(new Date(quote.asOf), inst.currency).slice(0, 10)) : today;
  // Adjusted, so a split between the previous close and today doesn't read as a crash.
  const prev = all.filter((p) => p.date < quoteDate).at(-1);
  const changePct = shown.length > 1 ? (quote?.price ?? shown.at(-1)!.close) / shown[0].close - 1 : null;

  const trades: Marker[] = inputs.trades.map((e) => {
    const f = factorAfter(e.date, actions);
    const kind: MarkerKind = e.type === "sell" ? "sell" : "buy";
    return {
      kind,
      date: e.date,
      t: tOf(e.date),
      price: e.price / f,
      qty: e.qty * f,
      approximate: e.approximate,
      label: e.type === "opening" ? "Held at first sync" : kind === "buy" ? "Bought" : "Sold",
    };
  });
  const watched: Marker[] = inputs.watch
    .filter((w) => w.priceAtAdd != null)
    .map((w) => {
      const date = isoInMarket(w.addedAt, inst.currency).slice(0, 10);
      return {
        kind: "watch" as const,
        date,
        t: tOf(date),
        price: adj(w.priceAtAdd!, date),
        qty: null,
        approximate: false,
        label: w.archived ? "Watched (archived)" : "Added to watchlist",
      };
    });
  const markers = [...trades, ...watched]
    .filter((m) => m.date >= from && m.date <= today)
    .sort((a, b) => a.t - b.t)
    .map((m) => redactForActor(actor, m, MARKER_POLICY));

  const targets = inputs.activeTargets;
  const marks = nearestMarks(targets).get(inst.id);
  const levels = [
    ...(marks?.target != null ? [{ kind: "target" as const, price: marks.target }] : []),
    ...(marks?.stop != null ? [{ kind: "stop" as const, price: marks.stop }] : []),
  ];

  return {
    amountsHidden: actor.hideAmounts,
    instrument: {
      ...inst,
      capLabel: inst.marketCap ? CAP_LABEL[capBucket(inst.market, inst.marketCap, inputs.capThresholds)] : null,
    },
    quote: quote ? { ...quote, dayChangePct: prev ? quote.price / prev.close - 1 : null } : null,
    chart: {
      range: inputs.range,
      points,
      markers,
      levels,
      adjustedFor: actions.filter((a) => a.exDate > from && a.exDate <= today).sort((a, b) => a.exDate.localeCompare(b.exDate)),
      high: high && { date: high.date, close: high.close },
      low: low && { date: low.date, close: low.close },
      changePct,
    },
    position: buildPosition(inputs, quote?.price ?? null, today, actor),
    targets,
  };
}

function buildPosition(inputs: SymbolInputs, price: number | null, today: ISODate, actor: Actor): SymbolView["position"] {
  const { instrument: inst, snapshot } = inputs;
  let lots = inputs.lots.filter((l) => openQty(l) > 1e-9);
  // Held per the broker but no ledger lots yet: one approximate lot at the broker's average (same as Holdings).
  if (!lots.length && snapshot && snapshot.qty > 0)
    lots = [
      {
        eventId: "snapshot",
        instrumentId: inst.id,
        market: inst.market,
        currency: inst.currency,
        qty: snapshot.qty,
        costPerShare: snapshot.avgPrice,
        openDate: isoInMarket(snapshot.takenAt, inst.currency).slice(0, 10),
        fxRateAtOpen: 1,
        closed: [],
        approximate: true,
        bonus: false,
      },
    ];
  if (!lots.length) return null;

  const qty = lots.reduce((s, l) => s + openQty(l), 0);
  const cost = lots.reduce((s, l) => s + openQty(l) * l.costPerShare, 0);
  const avgCost = cost / qty;
  const rows: LotRow[] = lots
    .map((l) => {
      const q = openQty(l);
      const ltcgDate = ltcgEligibleDate(l.openDate, inst.market);
      return {
        eventId: l.eventId,
        openDate: l.openDate,
        qty: q,
        costPerShare: l.costPerShare,
        invested: q * l.costPerShare,
        sharePct: q / qty,
        returnPct: price != null && l.costPerShare > 0 ? price / l.costPerShare - 1 : null,
        ltcgDate,
        longTerm: today >= ltcgDate,
        daysToLtcg: Math.max(0, daysBetween(today, ltcgDate)),
        approximate: l.approximate,
        bonus: l.bonus,
        buckets: inputs.bucketsByEvent[l.eventId] ?? [],
      };
    })
    .sort((a, b) => a.openDate.localeCompare(b.openDate));
  const buckets = [...new Map(rows.flatMap((r) => r.buckets).map((b) => [b.id, b])).values()];

  return redactForActor(
    actor,
    {
      qty,
      avgCost,
      brokerAvg: snapshot && snapshot.qty > 0 ? snapshot.avgPrice : null,
      returnPct: price != null && avgCost > 0 ? price / avgCost - 1 : null,
      lots: rows.map((r) => redactForActor(actor, r, LOT_POLICY)),
      buckets,
    },
    POSITION_POLICY,
  );
}

// ---------- loading ----------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (s: string | null) => (s == null ? null : Number(s));

export async function getSymbolView(id: string, range: RangeKey) {
  const actor = await requireActor();
  if (!UUID.test(id)) return null;
  const [row] = await db
    .select({ i: instruments, p: priceLatest })
    .from(instruments)
    .leftJoin(priceLatest, eq(priceLatest.instrumentId, instruments.id))
    .where(eq(instruments.id, id));
  if (!row) return null;
  const { i, p } = row;
  const now = new Date();
  const today = isoInMarket(now, i.currency).slice(0, 10);
  // Two extra weeks before the range so the day change always has a previous close.
  const start = rangeStart(range, today);
  const since = start ? new Date(tOf(start) - 14 * DAY_MS).toISOString().slice(0, 10) : null;

  const runIds = await latestSnapshotRunIds();
  const [bars, acts, ledger, snaps, watch, targetInputs, prefs, bucketList] = await Promise.all([
    db
      .select({ date: pricesDaily.date, close: pricesDaily.close })
      .from(pricesDaily)
      .where(and(eq(pricesDaily.instrumentId, id), since ? gte(pricesDaily.date, since) : undefined)),
    db.select().from(corporateActions).where(eq(corporateActions.instrumentId, id)),
    loadLedger(db, [id]),
    runIds.length
      ? db
          .select()
          .from(holdingSnapshots)
          .where(and(eq(holdingSnapshots.instrumentId, id), inArray(holdingSnapshots.runId, runIds), sql`${holdingSnapshots.qty} > 0`))
          .orderBy(desc(holdingSnapshots.takenAt))
      : [],
    db.select().from(watchItems).where(eq(watchItems.instrumentId, id)),
    loadTargetsInputs(now, id),
    loadPreferences(),
    listBuckets(),
  ]);

  const byId = new Map(ledger.events.map((e) => [e.id, e]));
  const { openLots } = replay(ledger.events, ledger.supersessions);
  const inBuckets = await bucketIdsFor("buy_event", openLots.map((l) => l.eventId));
  const chip = new Map(bucketList.map((b) => [b.id, b]));
  const targetsView = buildTargetsView(targetInputs, actor);

  const inputs: SymbolInputs = {
    instrument: {
      id: i.id,
      symbol: i.brokerSymbol,
      name: i.name,
      market: i.market,
      currency: i.currency,
      exchange: i.exchange,
      sector: i.sector,
      industry: i.industry,
      marketCap: num(i.marketCap),
      priceUnavailable: i.priceUnavailable,
    },
    price: p && !i.priceUnavailable ? { price: Number(p.price), asOf: p.asOf, source: p.source } : null,
    bars: bars.map((b) => ({ date: b.date, close: Number(b.close) })),
    actions: acts.map((a) => ({ exDate: a.exDate, ratio: Number(a.numerator) / Number(a.denominator) })),
    trades: liveEvents(ledger.events, ledger.supersessions).flatMap((e) =>
      e.type === "buy" || e.type === "sell" || e.type === "opening"
        ? [{ id: e.id, type: e.type, date: e.date, qty: e.qty, price: e.price, approximate: e.approximate }]
        : [],
    ),
    lots: openLots.map((l) => ({ ...l, approximate: byId.get(l.eventId)?.approximate ?? false, bonus: byId.get(l.eventId)?.type === "bonus" })),
    snapshot: snaps[0] ? { qty: Number(snaps[0].qty), avgPrice: Number(snaps[0].avgPrice), takenAt: snaps[0].takenAt } : null,
    watch: watch.map((w) => ({ id: w.id, addedAt: w.addedAt, priceAtAdd: num(w.priceAtAdd), archived: w.archivedAt != null })),
    activeTargets: targetsView.active,
    bucketsByEvent: Object.fromEntries(
      [...inBuckets].map(([ev, ids]) => [ev, ids.flatMap((b) => (chip.has(b) ? [chip.get(b)!] : []))]),
    ),
    capThresholds: prefs.capThresholds,
    range,
    now,
  };
  return {
    view: buildSymbolView(inputs, actor),
    targets: { history: targetsView.history, canCreate: targetsView.canCreate },
  };
}
