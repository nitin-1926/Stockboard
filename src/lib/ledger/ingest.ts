import { and, between, desc, eq, inArray, isNull, lt, lte, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  corporateActions,
  fxDaily,
  holdingSnapshots,
  instruments,
  ledgerEvents,
  ledgerReviewQueue,
  ledgerSupersessions,
  priceLatest,
  pricesDaily,
} from "@/db/schema";
import { type Actor, can } from "@/lib/auth/access";
import { copyBucketMembers, inheritBuckets } from "@/lib/buckets/inherit";
import { copyJournalRefs } from "@/lib/journal/actions";
import { ensureFxRange } from "@/lib/market/fx";
import { backfillHistory } from "@/lib/market/prices";
import { copyWatchLinks, linkWatchedBuys } from "@/lib/watch/link-buys";
import { WINDOW_DAYS } from "./corporate-actions";
import {
  applyHistoricalActions,
  dateRange,
  parseConsoleTradebook,
  parseUsHistory,
  reconcile,
  type RowError,
  toEvents,
  usHistoryToEvents,
} from "./csv-import";
import { includedAt, inferFromSnapshot } from "./infer";
import { EPS, liveEvents, replay } from "./lots";
import { eventId, isoInMarket, loadActions, loadLedger, type Q, type Tx } from "./queries";
import { planSupersession } from "./supersede";
import type { Anomaly, Currency, ISODate, LedgerEvent, Snapshot, Supersession } from "./types";
import { addDays, effDate } from "./types";

/**
 * Ledger DB layer (U11b). Every public call: network prefetch (FX, split history)
 * first, then ONE Pool transaction under a global advisory lock that re-reads the
 * ledger, plans, and writes. Inserts are idempotent on source_ref.
 */

type Broker = "kite" | "indmoney";
type ReviewKind = (typeof ledgerReviewQueue.$inferInsert)["kind"];
interface ReviewItem {
  instrumentId: string;
  kind: ReviewKind;
  detail: Record<string, unknown>;
}

/**
 * Copies bucket_members / watch_items.linked_buy_event_id / journal refs from a
 * superseded buy onto every superseding buy (keys and values are DB event ids).
 * U14, U15 and U20 add theirs here (journal entries move to the first superseding buy);
 * they run inside the ingest transaction.
 */
export type RefCopier = (tx: Tx, remap: Map<string, string[]>) => Promise<void>;
export const REF_COPIERS: RefCopier[] = [copyWatchLinks, copyBucketMembers, copyJournalRefs];

// ponytail: one global ledger lock; per-instrument locks if ingest ever contends.
const lock = (tx: Tx) => tx.execute(sql`select pg_advisory_xact_lock(hashtext('ledger'))`);

// ---------- writes (inside the transaction) ----------

function toRow(e: LedgerEvent, broker: Broker | null, anomaly: string | undefined) {
  // Postgres numeric accepts 'NaN' (and NaN > 0 is true there), so the CHECK can't catch it.
  if (![e.qty, e.price, e.fxRateInr].every(Number.isFinite) || !(e.fxRateInr > 0))
    throw new Error(`ledger event ${e.sourceRef}: non-finite qty/price or missing FX rate`);
  return {
    id: eventId(e.id),
    instrumentId: e.instrumentId,
    broker,
    type: e.type,
    date: e.date,
    exDate: e.exDate ?? null,
    executedAt: e.executedAt ? new Date(e.executedAt) : null,
    qty: String(e.qty),
    price: String(e.price),
    currency: e.currency,
    fxRateInr: String(e.fxRateInr),
    source: e.source,
    sourceRef: e.sourceRef,
    approximate: e.approximate,
    ratioNum: e.ratio ? String(e.ratio.num) : null,
    ratioDen: e.ratio ? String(e.ratio.den) : null,
    anomaly: anomaly ?? null,
  };
}

const anomalyItem = (a: Anomaly): ReviewItem => ({
  instrumentId: a.instrumentId,
  kind: a.kind,
  detail: { message: a.message, ...(a.eventId ? { eventId: eventId(a.eventId) } : {}) },
});

/** One open item per (instrument, kind) (partial unique index); a newer detail replaces the old. */
async function flag(tx: Tx, items: ReviewItem[]) {
  const uniq = [...new Map(items.map((i) => [`${i.instrumentId}:${i.kind}`, i])).values()];
  if (!uniq.length) return;
  await tx
    .insert(ledgerReviewQueue)
    .values(uniq)
    .onConflictDoUpdate({
      target: [ledgerReviewQueue.instrumentId, ledgerReviewQueue.kind],
      targetWhere: sql`resolved_at is null`,
      set: { detail: sql`excluded.detail` },
    });
}

/**
 * Events first, then remainders' links, then ref copies, then watch-item links and
 * bucket inheritance for new buys (after the copies, so a remapped link is never
 * overwritten and a replacing buy keeps exactly its predecessor's buckets), then review items.
 * Remainders must be in `events`: the links reference them.
 */
async function commit(
  tx: Tx,
  p: {
    broker: Broker | null;
    events: LedgerEvent[];
    anomalies?: Anomaly[];
    supersessions?: Supersession[];
    refRemap?: Map<string, string[]>;
    review?: ReviewItem[];
  },
) {
  const note = new Map((p.anomalies ?? []).flatMap((a) => (a.eventId ? [[a.eventId, a.message] as const] : [])));
  const inserted = p.events.length
    ? await tx
        .insert(ledgerEvents)
        .values(p.events.map((e) => toRow(e, p.broker, note.get(e.id))))
        .onConflictDoNothing({ target: ledgerEvents.sourceRef })
        .returning({ id: ledgerEvents.id })
    : [];
  const links = p.supersessions ?? [];
  const linked = links.length
    ? await tx
        .insert(ledgerSupersessions)
        .values(links.map((s) => ({ supersededId: eventId(s.supersededId), supersedingId: eventId(s.supersedingId) })))
        .onConflictDoNothing()
        .returning({ id: ledgerSupersessions.supersededId })
    : [];
  const remap = new Map([...(p.refRemap ?? [])].map(([k, v]) => [eventId(k), v.map(eventId)]));
  if (remap.size) for (const copy of REF_COPIERS) await copy(tx, remap);
  await linkWatchedBuys(tx, inserted.map((r) => r.id));
  await inheritBuckets(tx, inserted.map((r) => r.id), new Set([...remap.values()].flat()));
  await flag(tx, [...(p.review ?? []), ...(p.anomalies ?? []).map(anomalyItem)]);
  return { inserted: inserted.length, superseded: new Set(linked.map((l) => l.id)).size };
}

/** Oversells surfaced by replaying the instruments' live ledger after a write. */
async function flagOversells(tx: Tx, instrumentIds: string[]) {
  const { events, supersessions } = await loadLedger(tx, instrumentIds);
  await flag(tx, replay(events, supersessions).anomalies.map(anomalyItem));
}

// ---------- snapshot runs ----------

interface RunItem {
  curr: Snapshot;
  currency: Currency;
  events: LedgerEvent[];
  anomalies: Anomaly[];
  review: ReviewItem[];
  /** Not lagging any more: open pending_lag items for the instrument get resolved. */
  settled: boolean;
  /** Residual with no cached split in the window: fetch split history before the transaction. */
  fetchActions: boolean;
}

/**
 * Reads everything a run needs through `q` and runs the pure inference. Called
 * once on the pool (to find what to prefetch) and again inside the transaction.
 * An exit is only seen if U10 writes a 0-qty row for an instrument that left the
 * holdings; an instrument absent from the run is not touched.
 */
async function planRun(q: Q, runId: string, bootstrapOnly = false, pending: Fill[] = []) {
  const rows = await q
    .select({ s: holdingSnapshots, currency: instruments.currency })
    .from(holdingSnapshots)
    .innerJoin(instruments, eq(instruments.id, holdingSnapshots.instrumentId))
    .where(eq(holdingSnapshots.runId, runId));
  if (!rows.length) return { broker: null, items: [] as RunItem[] };
  const { broker, takenAt: runAt } = rows[0].s;
  const snaps = new Map(
    rows.map(({ s, currency }) => [
      s.instrumentId,
      { currency, takenAt: s.takenAt, qty: Number(s.qty), avg: Number(s.avgPrice), ltp: s.ltp == null ? null : Number(s.ltp) },
    ]),
  );
  const ids = [...snaps.keys()];
  const dateOf = (s: { takenAt: Date; currency: Currency }) => isoInMarket(s.takenAt, s.currency).slice(0, 10);
  const dates = [...new Set([...snaps.values()].map(dateOf))];

  const [{ events, supersessions }, actions, prevRows, closes, latest, fx] = await Promise.all([
    loadLedger(q, ids),
    loadActions(q, ids),
    q
      .selectDistinctOn([holdingSnapshots.instrumentId])
      .from(holdingSnapshots)
      .where(
        and(
          inArray(holdingSnapshots.instrumentId, ids),
          eq(holdingSnapshots.broker, broker),
          ne(holdingSnapshots.runId, runId),
          lt(holdingSnapshots.takenAt, runAt),
        ),
      )
      .orderBy(holdingSnapshots.instrumentId, desc(holdingSnapshots.takenAt)),
    q
      .select()
      .from(pricesDaily)
      .where(and(inArray(pricesDaily.instrumentId, ids), inArray(pricesDaily.date, dates))),
    q.select().from(priceLatest).where(inArray(priceLatest.instrumentId, ids)),
    q.select().from(fxDaily).where(inArray(fxDaily.date, dates)),
  ]);
  const prevs = new Map(prevRows.map((r) => [r.instrumentId, r]));
  const closeOf = new Map(closes.map((r) => [`${r.instrumentId}:${r.date}`, Number(r.close)]));
  const latestOf = new Map(latest.map((r) => [r.instrumentId, Number(r.price)]));
  const fxOn = new Map(fx.map((r) => [r.date, Number(r.usdInr)]));

  const items = [...snaps].map(([id, s]): RunItem => {
    const curr: Snapshot = { runId, takenAt: isoInMarket(s.takenAt, s.currency), broker, instrumentId: id, qty: s.qty, avgPrice: s.avg };
    const date = curr.takenAt.slice(0, 10);
    // NaN until prefetched; toRow refuses to write it.
    const fxRateInr = s.currency === "INR" ? 1 : (fxOn.get(date) ?? Number.NaN);
    const item: RunItem = { curr, currency: s.currency, events: [], anomalies: [], review: [], settled: false, fetchActions: false };
    const mine = events.filter((e) => e.instrumentId === id);

    // Bootstrap: nothing on the ledger yet → the first snapshot is an approximate opening at the broker's avg.
    // The snapshot already reflects today's fills (`pending`, ingested right after), so the opening is
    // the position before them; otherwise opening + fills would count today's trades twice.
    if (!liveEvents(mine, supersessions).length) {
      const ref = `opening:${broker}:${id}`;
      const today = pending
        .filter((f) => f.instrumentId === id && Date.parse(f.executedAt) <= s.takenAt.getTime())
        .reduce((n, f) => n + (f.side === "buy" ? f.qty : -f.qty), 0);
      const qty = s.qty - today;
      if (qty > EPS)
        item.events.push({
          id: ref,
          sourceRef: ref,
          instrumentId: id,
          type: "opening",
          source: "opening",
          date,
          executedAt: curr.takenAt,
          qty,
          price: s.avg,
          currency: s.currency,
          fxRateInr,
          approximate: true,
        });
      return item;
    }
    if (bootstrapOnly) return item;

    // Inferred sells: the official close if EOD already stored it, else the latest quote (approximate; U17 re-prices).
    const close = closeOf.get(`${id}:${date}`);
    const [price, priceSource] =
      close != null ? [close, "close"] : latestOf.has(id) ? [latestOf.get(id)!, "latest"] : s.ltp != null ? [s.ltp, "ltp"] : [Number.NaN, "none"];
    const p = prevs.get(id);
    const prev: Snapshot | null = p
      ? { runId: p.runId, takenAt: isoInMarket(p.takenAt, s.currency), broker, instrumentId: id, qty: Number(p.qty), avgPrice: Number(p.avgPrice) }
      : null;
    const r = inferFromSnapshot({ events: mine, supersessions, prev, curr, priceForDate: price, currency: s.currency, fxRateInr, actions });
    const detail = { runId, takenAt: curr.takenAt, residual: r.residual };
    if (r.pendingLag) {
      item.review.push({ instrumentId: id, kind: "pending_lag", detail });
      return item;
    }
    item.settled = true;
    item.fetchActions =
      r.residual !== 0 &&
      !actions.some((a) => a.instrumentId === id && a.exDate <= date && a.exDate >= addDays(date, -WINDOW_DAYS));
    if (r.unexplained) {
      item.review.push({ instrumentId: id, kind: "unexplained", detail: { ...detail, reason: r.unexplained } });
      return item;
    }
    const sell = r.events.find((e) => e.type === "sell");
    if (sell && !(sell.price > 0)) {
      item.review.push({ instrumentId: id, kind: "unexplained", detail: { ...detail, reason: `no price on ${date} for an inferred sell` } });
      return item;
    }
    if (sell && priceSource !== "close")
      item.review.push({
        instrumentId: id,
        kind: "approximate_sell",
        detail: { ...detail, eventId: eventId(sell.id), price: sell.price, priceSource },
      });
    item.events = r.events;
    item.anomalies = r.anomalies;
    return item;
  });
  return { broker, items };
}

async function prefetchRun(runId: string, fetchSplits: boolean) {
  const dry = await planRun(db, runId, !fetchSplits);
  const usd = dry.items.filter((i) => i.currency === "USD").map((i) => i.curr.takenAt.slice(0, 10)).sort();
  if (usd.length) await ensureFxRange(usd[0], usd[usd.length - 1]);
  for (const i of dry.items) if (fetchSplits && i.fetchActions) await fetchSplitHistory(i.curr.instrumentId);
}

/** U8 fetch, on demand: upserts corporate_actions (and refetches full raw history if a new split appears). */
async function fetchSplitHistory(instrumentId: string, range = "3mo") {
  const [i] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (i) await backfillHistory(i, { range });
}

/**
 * Residual inference for one sync run (U10 calls it after writing the run's
 * holding_snapshots). Re-running the same run is a no-op.
 */
export async function ingestSnapshotRun(runId: string) {
  await prefetchRun(runId, true);
  return db.transaction(async (tx) => {
    await lock(tx);
    const { broker, items } = await planRun(tx, runId);
    const r = await commit(tx, {
      broker,
      events: items.flatMap((i) => i.events),
      anomalies: items.flatMap((i) => i.anomalies),
      review: items.flatMap((i) => i.review),
    });
    const settled = items.filter((i) => i.settled).map((i) => i.curr.instrumentId);
    if (settled.length)
      await tx
        .update(ledgerReviewQueue)
        .set({ resolvedAt: new Date(), resolvedBy: "ingest" })
        .where(
          and(
            inArray(ledgerReviewQueue.instrumentId, settled),
            eq(ledgerReviewQueue.kind, "pending_lag"),
            isNull(ledgerReviewQueue.resolvedAt),
          ),
        );
    return { inserted: r.inserted, review: items.reduce((n, i) => n + i.review.length, 0) };
  });
}

/**
 * First-ever snapshot of an instrument → approximate `opening:<broker>:<instrumentId>` at the broker's avg.
 * `pending` = the fills U10 ingests next (ingestFills) for this run: the opening excludes their net qty.
 */
export async function bootstrapOpenings(runId: string, pending: Fill[] = []) {
  await prefetchRun(runId, false);
  return db.transaction(async (tx) => {
    await lock(tx);
    const { broker, items } = await planRun(tx, runId, true, pending);
    return commit(tx, { broker, events: items.flatMap((i) => i.events) });
  });
}

// ---------- fills ----------

/** A broker trade (U10's broker_trades row). `executedAt` must carry the market's offset. */
export interface Fill {
  tradeId: string;
  instrumentId: string;
  side: "buy" | "sell";
  qty: number;
  /** Native currency per share. */
  price: number;
  executedAt: string;
}

const HAS_OFFSET = /T.*(Z|[+-]\d{2}:\d{2})$/i;

async function fxMap(from: ISODate, to: ISODate) {
  await ensureFxRange(from, to);
  const rows = await db.select().from(fxDaily).where(between(fxDaily.date, from, to));
  return new Map(rows.map((r) => [r.date, Number(r.usdInr)]));
}

/**
 * Fills → `fill:<trade_id>` events; supersedes inferred events they explain
 * (partial cover leaves an approximate remainder). Already-stored fills are skipped.
 */
export async function ingestFills(broker: Broker, fills: Fill[]) {
  if (!fills.length) return { inserted: 0, superseded: 0 };
  const bad = fills.find((f) => !HAS_OFFSET.test(f.executedAt));
  if (bad) throw new Error(`fill ${bad.tradeId}: executedAt "${bad.executedAt}" has no UTC offset`);
  const ids = [...new Set(fills.map((f) => f.instrumentId))];
  const cur = new Map(
    (await db.select({ id: instruments.id, currency: instruments.currency }).from(instruments).where(inArray(instruments.id, ids))).map(
      (r) => [r.id, r.currency],
    ),
  );
  const usdDates = fills
    .filter((f) => cur.get(f.instrumentId) === "USD")
    .map((f) => isoInMarket(new Date(f.executedAt), "USD").slice(0, 10))
    .sort();
  const fx = usdDates.length ? await fxMap(usdDates[0], usdDates[usdDates.length - 1]) : new Map<string, number>();

  const incoming = fills.map((f): LedgerEvent => {
    const currency = cur.get(f.instrumentId);
    if (!currency) throw new Error(`fill ${f.tradeId}: unknown instrument ${f.instrumentId}`);
    // Re-express in the market's zone so the date is the exchange date whatever offset U10 sent.
    const executedAt = isoInMarket(new Date(f.executedAt), currency);
    const date = executedAt.slice(0, 10);
    const ref = `fill:${f.tradeId}`;
    return {
      id: ref,
      sourceRef: ref,
      instrumentId: f.instrumentId,
      type: f.side,
      date,
      executedAt,
      qty: f.qty,
      price: f.price,
      currency,
      fxRateInr: currency === "INR" ? 1 : (fx.get(date) ?? Number.NaN),
      source: "fill",
      approximate: false,
    };
  });

  return db.transaction(async (tx) => {
    await lock(tx);
    const r = await writeWithSupersession(tx, broker, ids, incoming);
    await flagOversells(tx, ids);
    return { inserted: r.inserted, superseded: r.superseded };
  });
}

/**
 * Plan supersession of new events against the live ledger and write it all.
 * Events whose source_ref is already stored are dropped first, so re-ingesting
 * never re-allocates a fill to a different inferred event.
 */
async function writeWithSupersession(tx: Tx, broker: Broker, ids: string[], all: LedgerEvent[]) {
  const { events: existing, supersessions: prior } = await loadLedger(tx, ids);
  const stored = new Set(existing.map((e) => e.sourceRef));
  const incoming = all.filter((e) => !stored.has(e.sourceRef));
  const plan = planSupersession(existing, incoming, prior);
  const r = await commit(tx, {
    broker,
    events: [...incoming, ...plan.remainders],
    supersessions: plan.supersessions,
    refRemap: plan.refRemap,
  });
  return { ...r, events: [...existing, ...incoming, ...plan.remainders], supersessions: [...prior, ...plan.supersessions] };
}

// ---------- trade imports ----------

export type ImportResult =
  | { errors: RowError[] }
  | { inserted: number; superseded: number; unexplained: { symbol: string; residual: number }[] };

type NewInstrument = typeof instruments.$inferInsert;

/** Find-or-create by (market, broker_symbol). Reference data, so it runs before (and outside) the ledger transaction. */
async function upsertInstruments(list: NewInstrument[]) {
  await db.insert(instruments).values(list).onConflictDoNothing();
  const rows = await db
    .select()
    .from(instruments)
    .where(
      and(
        eq(instruments.market, list[0].market),
        inArray(
          instruments.brokerSymbol,
          list.map((i) => i.brokerSymbol),
        ),
      ),
    );
  return new Map(rows.map((r) => [r.brokerSymbol, r]));
}

/**
 * Shared tail of both imports: split history (prefetched), supersession, then
 * reconcile each instrument against its latest broker snapshot. A shortfall
 * becomes an approximate opening + 'unexplained_opening' review item.
 */
async function importEvents(
  broker: Broker,
  events: LedgerEvent[],
  byId: Map<string, { symbol: string }>,
  fxRateFor: (d: ISODate) => number,
): Promise<ImportResult> {
  const ids = [...byId.keys()];
  // Historical splits/bonuses from the first imported trade on (adopted fix), fetched before the transaction.
  for (const id of ids) await fetchSplitHistory(id, "max");
  const withActions = applyHistoricalActions(events, await loadActions(db, ids));

  return db.transaction(async (tx) => {
    await lock(tx);
    const w = await writeWithSupersession(tx, broker, ids, withActions);
    const latest = await tx
      .selectDistinctOn([holdingSnapshots.instrumentId])
      .from(holdingSnapshots)
      .where(and(inArray(holdingSnapshots.instrumentId, ids), eq(holdingSnapshots.broker, broker)))
      .orderBy(holdingSnapshots.instrumentId, desc(holdingSnapshots.takenAt));

    const live = liveEvents(w.events, w.supersessions);
    const extra: LedgerEvent[] = [];
    const anomalies: Anomaly[] = [];
    const unexplained: { symbol: string; residual: number }[] = [];
    for (const s of latest) {
      const id = s.instrumentId;
      const currency = events.find((e) => e.instrumentId === id)!.currency;
      const at = isoInMarket(s.takenAt, currency);
      const pos = replay(live.filter((e) => e.instrumentId === id && includedAt(e, at))).positions[id] ?? { qty: 0, cost: 0 };
      // A shortfall is most likely shares bought before the file starts: date the opening at the first trade.
      const first = dateRange(events.filter((e) => e.instrumentId === id))!.from;
      const r = reconcile({
        instrumentId: id,
        date: first,
        replayedQty: pos.qty,
        replayedCost: pos.cost,
        brokerQty: Number(s.qty),
        brokerAvg: Number(s.avgPrice),
        currency,
        fxRateInr: fxRateFor(first),
      });
      if (r.event) extra.push(r.event);
      if (r.anomaly) anomalies.push(r.anomaly);
      if (r.residual) unexplained.push({ symbol: byId.get(id)!.symbol, residual: r.residual });
    }
    const rec = await commit(tx, { broker, events: extra, anomalies });
    await flagOversells(tx, ids);
    return { inserted: w.inserted + rec.inserted, superseded: w.superseded, unexplained };
  });
}

const assertOwner = (actor: Actor) => {
  if (!can(actor, "manage")) throw new Error("Forbidden");
};

/**
 * Zerodha Console tradebook → csv events (all-or-nothing: any row error → nothing
 * written). INR only, so no FX prefetch is needed (rate 1).
 */
export async function importConsoleCsv(text: string, actor: Actor): Promise<ImportResult> {
  assertOwner(actor);
  const { rows, errors } = parseConsoleTradebook(text);
  if (errors.length) return { errors };
  if (!rows.length) return { errors: [{ row: 1, message: "no trades in file" }] };

  // NSE and BSE rows of one symbol are one instrument (Kite's broker symbol); prefer the NSE listing.
  const exchangeOf = new Map<string, string>();
  for (const r of rows) if (!exchangeOf.has(r.symbol) || r.exchange === "NSE") exchangeOf.set(r.symbol, r.exchange);
  const bySymbol = await upsertInstruments(
    [...exchangeOf].map(([symbol, exchange]) => ({ market: "IN", exchange, brokerSymbol: symbol, name: symbol, currency: "INR" })),
  );
  const conv = toEvents(rows, (r) => bySymbol.get(r.symbol)?.id);
  if (conv.errors.length) return { errors: conv.errors };
  const byId = new Map([...bySymbol.values()].map((i) => [i.id, { symbol: i.brokerSymbol }]));
  return importEvents("kite", conv.events, byId, () => 1);
}

/**
 * US trade history (format assumed until the U1 spike pins INDmoney's export;
 * only parseUsHistory changes then). INR cost basis uses USD/INR on each trade
 * date, prefetched and forward-filled before the transaction.
 */
export async function importUsHistory(text: string, actor: Actor): Promise<ImportResult> {
  assertOwner(actor);
  const { rows, errors } = parseUsHistory(text);
  if (errors.length) return { errors };
  if (!rows.length) return { errors: [{ row: 1, message: "no trades in file" }] };

  const dates = rows.map((r) => r.date).sort();
  const fx = await fxMap(dates[0], dates[dates.length - 1]);
  const symbols = [...new Set(rows.map((r) => r.symbol.toUpperCase()))];
  const bySymbol = await upsertInstruments(
    symbols.map((s) => ({ market: "US", exchange: "US", brokerSymbol: s, name: s, currency: "USD" })),
  );
  const conv = usHistoryToEvents(rows, (r) => bySymbol.get(r.symbol.toUpperCase())?.id, (d) => fx.get(d));
  if (conv.errors.length) return { errors: conv.errors };
  const byId = new Map([...bySymbol.values()].map((i) => [i.id, { symbol: i.brokerSymbol }]));
  return importEvents("indmoney", conv.events, byId, (d) => fx.get(d) ?? Number.NaN);
}

// ---------- owner corrections (U18) ----------

const CORRECTABLE = new Set<LedgerEvent["type"]>(["buy", "sell", "opening", "dividend"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const by = (actor: Actor) => actor.email ?? "owner";

/**
 * Owner correction of one event's date and/or price: a `manual:<eventId>` event that
 * supersedes exactly that event (ADR-0005: append and link, never UPDATE). The link is
 * built here, not by planSupersession's manual rule: that rule replaces every same-type
 * event on the manual event's date, so it would also drop a second trade that day and
 * miss the original when the date moves. Ref copiers (buckets, watch links) run for buys
 * through `commit`, as at ingest. Open review items about the event are resolved.
 */
export async function correctEvent(id: string, patch: { date?: ISODate; price?: number }, actor: Actor) {
  assertOwner(actor);
  if (patch.date != null && (!ISO_DATE.test(patch.date) || Number.isNaN(Date.parse(patch.date))))
    throw new Error("Date must be YYYY-MM-DD");
  if (patch.price != null && !(Number.isFinite(patch.price) && patch.price > 0)) throw new Error("Price must be a positive number");
  const [row] = await db.select().from(ledgerEvents).where(eq(ledgerEvents.id, id));
  if (!row) throw new Error("Event not found");
  const date = patch.date ?? row.date;
  if (date > isoInMarket(new Date(), row.currency).slice(0, 10)) throw new Error("Date is in the future");
  // Network before the transaction (as every ingest path): the rate for a moved US trade.
  if (row.currency === "USD" && date !== row.date) await ensureFxRange(date, date);

  return db.transaction(async (tx) => {
    await lock(tx);
    const { events, supersessions } = await loadLedger(tx, [row.instrumentId]);
    const target = events.find((e) => e.id === id)!;
    if (supersessions.some((s) => s.supersededId === id)) throw new Error("This event was already replaced. Correct the newer one.");
    if (!CORRECTABLE.has(target.type)) throw new Error(`A ${target.type} can't be corrected here`);
    const price = patch.price ?? target.price;
    if (date === target.date && price === target.price) throw new Error("Nothing changed");
    let fxRateInr = target.fxRateInr;
    if (target.currency === "USD" && date !== target.date) {
      const [fx] = await tx.select().from(fxDaily).where(lte(fxDaily.date, date)).orderBy(desc(fxDaily.date)).limit(1);
      if (!fx) throw new Error(`No USD/INR rate on or before ${date}`);
      fxRateInr = Number(fx.usdInr);
    }
    const ref = `manual:${target.id}`;
    const manual: LedgerEvent = {
      ...target,
      id: ref,
      sourceRef: ref,
      source: "manual",
      date,
      price,
      fxRateInr,
      approximate: false,
      executedAt: date === target.date ? target.executedAt : undefined,
    };
    const isBuy = target.type === "buy" || target.type === "opening";
    await commit(tx, {
      broker: row.broker,
      events: [manual],
      supersessions: [{ supersededId: target.id, supersedingId: ref }],
      refRemap: isBuy ? new Map([[target.id, [ref]]]) : undefined,
    });
    await flagOversells(tx, [row.instrumentId]);
    await tx
      .update(ledgerReviewQueue)
      .set({ resolvedAt: new Date(), resolvedBy: by(actor) })
      .where(
        and(
          eq(ledgerReviewQueue.instrumentId, row.instrumentId),
          isNull(ledgerReviewQueue.resolvedAt),
          sql`${ledgerReviewQueue.detail}->>'eventId' = ${id}`,
        ),
      );
    return { eventId: eventId(ref) };
  });
}

/**
 * Yahoo reports bonuses as splits. Reclassifying flips the corporate_actions row (later
 * matches, valuations and target rescaling read the kind; confirmed_by_owner records the
 * call) and, if the ledger already credited it as a split, supersedes that event with a
 * `manual` bonus: same ratio, ex-date and allotment date (U11a made the flip a type change),
 * so replay turns the extra shares into a zero-cost lot dated at allotment.
 */
export async function reclassifyAsBonus(instrumentId: string, exDate: ISODate, actor: Actor) {
  assertOwner(actor);
  return db.transaction(async (tx) => {
    await lock(tx);
    const flipped = await tx
      .update(corporateActions)
      .set({ kind: "bonus", confirmedByOwner: true })
      .where(and(eq(corporateActions.instrumentId, instrumentId), eq(corporateActions.exDate, exDate)))
      .returning({ id: corporateActions.id });
    const { events, supersessions } = await loadLedger(tx, [instrumentId]);
    const split = liveEvents(events, supersessions).find((e) => e.type === "split" && effDate(e) === exDate);
    if (!split && !flipped.length) throw new Error(`No split on ${exDate} to reclassify`);
    if (split) {
      const [r] = await tx.select({ broker: ledgerEvents.broker }).from(ledgerEvents).where(eq(ledgerEvents.id, split.id));
      const ref = `manual:${split.id}`;
      await commit(tx, {
        broker: r.broker,
        events: [{ ...split, id: ref, sourceRef: ref, type: "bonus", source: "manual" }],
        supersessions: [{ supersededId: split.id, supersedingId: ref }],
      });
      await flagOversells(tx, [instrumentId]);
    }
    return { flipped: flipped.length > 0, superseded: !!split };
  });
}

/** Close a review item without a ledger change; `detail.resolution` records which. */
export async function resolveReviewItem(id: string, resolution: "resolved" | "ignored", actor: Actor) {
  assertOwner(actor);
  const done = await db
    .update(ledgerReviewQueue)
    .set({
      resolvedAt: new Date(),
      resolvedBy: by(actor),
      detail: sql`${ledgerReviewQueue.detail} || ${JSON.stringify({ resolution })}::jsonb`,
    })
    .where(and(eq(ledgerReviewQueue.id, id), isNull(ledgerReviewQueue.resolvedAt)))
    .returning({ id: ledgerReviewQueue.id });
  if (!done.length) throw new Error("Already resolved");
}
