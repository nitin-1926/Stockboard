import { and, between, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { dividends, fxDaily, instruments, ledgerEvents, ledgerReviewQueue, ledgerSupersessions, pricesDaily } from "@/db/schema";
import { pendingFactor } from "@/lib/ledger/corporate-actions";
import { REF_COPIERS } from "@/lib/ledger/ingest";
import { EPS, liveEvents, replay } from "@/lib/ledger/lots";
import { eventId, isoInMarket, loadActions, loadLedger, type Tx } from "@/lib/ledger/queries";
import { addDays, effDate, factor, type ISODate } from "@/lib/ledger/types";
import { ensureFxRange, refreshFx } from "@/lib/market/fx";
import { backfillHistory } from "@/lib/market/prices";
import { heldQtyOn } from "@/lib/returns/pnl";
import type { Market } from "@/lib/returns/types";
import { evaluatePendingTargets } from "@/lib/targets/evaluate-job";
import { dividendWithholding } from "@/lib/views/buckets";
import { type Scope, trackedInstruments } from "./prices-intraday";
import type { JobResult } from "./registry";

// Per-market end of day (U17). Idempotent per (market, date): bars upsert, dividend events
// dedupe on source_ref, re-priced sells resolve their review item, the target evaluator
// writes only changes. No portfolio_values table: history is derived on read (U18).

const CURRENCY = { IN: "INR", US: "USD" } as const;
/** Dividends whose ex-date is this recent are (re)checked, so a late Yahoo event still lands. */
export const DIVIDEND_LOOKBACK_DAYS = 10;

const num = (x: number) => String(Number(x.toFixed(6)));
// Same lock as ingest.ts: these writes read the ledger and must not race an ingest.
const lockLedger = (tx: Tx) => tx.execute(sql`select pg_advisory_xact_lock(hashtext('ledger'))`);

export async function runEod(market: Market, { now = new Date(), only }: Scope & { now?: Date } = {}): Promise<JobResult> {
  const today = isoInMarket(now, CURRENCY[market]).slice(0, 10);
  const list = await trackedInstruments(market, { only });

  // a. Today's bars (+ split/dividend events; a new event makes U8 refetch full raw history).
  let bars = 0;
  let newEvents = 0;
  let failed = 0;
  for (const i of list) {
    try {
      const r = await backfillHistory(i, { range: "5d" });
      bars += r.bars;
      newEvents += r.newEvents;
    } catch (e) {
      failed++;
      console.error(`[eod] ${i.brokerSymbol} bars failed`, e);
    }
  }
  // Yahoo down is a failure, not a holiday.
  if (list.length && failed === list.length) throw new Error(`eod ${market}: every bar fetch failed`);

  // b. FX: before the holiday check, since ECB and exchange holidays differ.
  const fx = await refreshFx();
  const counts = { instruments: list.length, bars, newEvents, failed, fx };

  // g. No bar dated today for any tracked instrument (benchmarks included) → market holiday.
  const ids = list.map((i) => i.id);
  const [{ n }] = ids.length
    ? await db
        .select({ n: sql<number>`count(*)::int` })
        .from(pricesDaily)
        .where(and(inArray(pricesDaily.instrumentId, ids), eq(pricesDaily.date, today)))
    : [{ n: 0 }];
  if (n === 0) return { counts, status: "holiday" };

  const dividendEvents = await recordDividends(ids, market, today); // c
  const repriced = await repriceSells(market, only); // d
  const t = await evaluatePendingTargets(now, market); // e
  return {
    counts: {
      ...counts,
      dividendEvents,
      repriced,
      targetsChecked: t.checked,
      targetsResolved: t.resolved.hit + t.resolved.stopped + t.resolved.expired,
      targetsUpdated: t.updated,
    },
  };
}

/**
 * c. Dividends with an ex-date in the last DIVIDEND_LOOKBACK_DAYS → one `dividend` ledger event
 * per (instrument, ex-date) for the quantity held on the ex-date (ledger replay), recorded NET of
 * withholding (owner decision) with the gross kept. Qty is on the ex-date's raw share basis, the
 * same basis as the stored per-share amount (U12 note). Dated on the pay date, else the ex-date;
 * fx = USD/INR on the pay date, else the ex-date.
 */
async function recordDividends(ids: string[], market: Market, today: ISODate): Promise<number> {
  if (!ids.length) return 0;
  const divs = await db
    .select()
    .from(dividends)
    .where(and(inArray(dividends.instrumentId, ids), between(dividends.exDate, addDays(today, -DIVIDEND_LOOKBACK_DAYS), today)));
  if (!divs.length) return 0;

  // Network first, outside the transaction (same rule as ingest).
  const fx = new Map<string, number>();
  const usdDates = divs.filter((d) => d.currency === "USD").flatMap((d) => [d.exDate, d.payDate ?? d.exDate]).sort();
  if (usdDates.length) {
    const [from, to] = [usdDates[0], usdDates[usdDates.length - 1]];
    await ensureFxRange(from, to);
    for (const r of await db.select().from(fxDaily).where(between(fxDaily.date, from, to))) fx.set(r.date, Number(r.usdInr));
  }
  const rate = (await dividendWithholding())[market];

  return db.transaction(async (tx) => {
    await lockLedger(tx);
    const divIds = [...new Set(divs.map((d) => d.instrumentId))];
    const [{ events, supersessions }, actions] = await Promise.all([loadLedger(tx, divIds), loadActions(tx, divIds)]);
    const live = liveEvents(events, supersessions);
    const { openLots, closedLots } = replay(events, supersessions);
    const lots = [...openLots, ...closedLots];

    const rows = divs.flatMap((d) => {
      const id = d.instrumentId;
      const mine = live.filter((e) => e.instrumentId === id);
      // Lots are on the basis after every LEDGER split; undo the ones after the ex-date, and apply
      // actions the broker hasn't credited yet (ledger still pre-split, per-share already post-split).
      const later = mine
        .filter((e) => e.type === "split" && e.ratio && effDate(e) > d.exDate)
        .reduce((f, e) => f * factor(e.ratio!), 1);
      const qty =
        (heldQtyOn(lots.filter((l) => l.instrumentId === id), d.exDate) / later) * pendingFactor(id, d.exDate, actions, mine);
      if (qty <= EPS) return [];
      const fxRateInr = d.currency === "INR" ? 1 : (fx.get(d.payDate ?? "") ?? fx.get(d.exDate));
      if (!fxRateInr) throw new Error(`dividend ${id} ${d.exDate}: no USD/INR rate`);
      const gross = Number(d.amountPerShare);
      const ref = `div:${id}:${d.exDate}`;
      return [
        {
          id: eventId(ref),
          instrumentId: id,
          type: "dividend" as const,
          date: d.payDate ?? d.exDate,
          exDate: d.exDate,
          qty: num(qty),
          price: num(gross * (1 - rate)),
          currency: d.currency,
          fxRateInr: String(fxRateInr),
          source: "action" as const,
          sourceRef: ref,
          approximate: false,
          grossAmount: num(qty * gross),
          withholdingRate: String(rate),
        },
      ];
    });
    if (!rows.length) return 0;
    const ins = await tx
      .insert(ledgerEvents)
      .values(rows)
      .onConflictDoNothing({ target: ledgerEvents.sourceRef })
      .returning({ id: ledgerEvents.id });
    return ins.length;
  });
}

/**
 * d. Inferred sells priced off the latest quote (open `approximate_sell` review items, U11b)
 * get the official close once it is stored. Supersession, not an UPDATE (ADR-0005): the new
 * event `<ref>:close` keeps source `inferred`, so a later broker fill still supersedes it.
 * A sell already superseded (a fill arrived) just has its item resolved.
 */
async function repriceSells(market: Market, only?: string[]): Promise<number> {
  const items = await db
    .select({ item: ledgerReviewQueue })
    .from(ledgerReviewQueue)
    .innerJoin(instruments, eq(instruments.id, ledgerReviewQueue.instrumentId))
    .where(and(eq(ledgerReviewQueue.kind, "approximate_sell"), isNull(ledgerReviewQueue.resolvedAt), eq(instruments.market, market)));
  let n = 0;
  for (const { item } of items) {
    const oldId = item.detail.eventId;
    if (typeof oldId !== "string" || (only && !only.includes(item.instrumentId))) continue;
    const resolved = await db.transaction(async (tx) => {
      await lockLedger(tx);
      const [old] = await tx.select().from(ledgerEvents).where(eq(ledgerEvents.id, oldId));
      if (!old) return false;
      const [close] = await tx
        .select({ close: pricesDaily.close })
        .from(pricesDaily)
        .where(and(eq(pricesDaily.instrumentId, old.instrumentId), eq(pricesDaily.date, old.date)));
      if (!close) return false; // no official close yet: the next EOD retries
      const [gone] = await tx.select().from(ledgerSupersessions).where(eq(ledgerSupersessions.supersededId, old.id)).limit(1);
      if (!gone) {
        const ref = `${old.sourceRef}:close`;
        const [ins] = await tx
          .insert(ledgerEvents)
          .values({ ...old, id: eventId(ref), sourceRef: ref, price: close.close, createdAt: new Date() })
          .onConflictDoNothing({ target: ledgerEvents.sourceRef })
          .returning({ id: ledgerEvents.id });
        if (ins) {
          await tx.insert(ledgerSupersessions).values({ supersededId: old.id, supersedingId: ins.id }).onConflictDoNothing();
          const remap = new Map([[old.id, [ins.id]]]);
          for (const copy of REF_COPIERS) await copy(tx, remap);
        }
      }
      await tx
        .update(ledgerReviewQueue)
        .set({ resolvedAt: new Date(), resolvedBy: "eod" })
        .where(eq(ledgerReviewQueue.id, item.id));
      return true;
    });
    if (resolved) n++;
  }
  return n;
}
