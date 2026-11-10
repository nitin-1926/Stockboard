import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ledgerEvents, watchItems } from "@/db/schema";
import { isoInMarket, type Tx } from "@/lib/ledger/queries";

// Watch item ↔ real buy link (R14). Both run inside the ledger ingest transaction
// (src/lib/ledger/ingest.ts `commit`), so a link never exists without its buy.

/**
 * After new events are inserted: each active, unlinked watch item of an instrument
 * that just got a buy links to the earliest such buy dated on/after the day it was
 * added (market-local date). Openings and inferred-from-history rows are type
 * "opening", not "buy", so a first sync of an already-held stock never links.
 * An item that already has a link is never relinked (the second buy changes nothing).
 */
export async function linkWatchedBuys(tx: Tx, insertedEventIds: string[]) {
  if (!insertedEventIds.length) return;
  const buys = await tx
    .select({ id: ledgerEvents.id, instrumentId: ledgerEvents.instrumentId, date: ledgerEvents.date, currency: ledgerEvents.currency })
    .from(ledgerEvents)
    .where(and(inArray(ledgerEvents.id, insertedEventIds), eq(ledgerEvents.type, "buy")))
    .orderBy(asc(ledgerEvents.date), sql`${ledgerEvents.executedAt} asc nulls last`, asc(ledgerEvents.id));
  if (!buys.length) return;
  const items = await tx
    .select({ id: watchItems.id, instrumentId: watchItems.instrumentId, addedAt: watchItems.addedAt })
    .from(watchItems)
    .where(
      and(
        inArray(watchItems.instrumentId, [...new Set(buys.map((b) => b.instrumentId))]),
        isNull(watchItems.archivedAt),
        isNull(watchItems.linkedBuyEventId),
      ),
    );
  for (const w of items) {
    const buy = buys.find((b) => b.instrumentId === w.instrumentId && b.date >= isoInMarket(w.addedAt, b.currency).slice(0, 10));
    if (buy)
      await tx
        .update(watchItems)
        .set({ linkedBuyEventId: buy.id })
        .where(and(eq(watchItems.id, w.id), isNull(watchItems.linkedBuyEventId)));
  }
}

/**
 * REF_COPIERS entry: a linked buy that gets superseded (an inferred buy replaced by
 * fills or CSV rows) moves its link to the earliest superseding buy.
 */
export async function copyWatchLinks(tx: Tx, remap: Map<string, string[]>) {
  const linked = await tx
    .select({ id: watchItems.id, buy: watchItems.linkedBuyEventId })
    .from(watchItems)
    .where(inArray(watchItems.linkedBuyEventId, [...remap.keys()]));
  if (!linked.length) return;
  const targets = await tx
    .select({ id: ledgerEvents.id })
    .from(ledgerEvents)
    .where(and(inArray(ledgerEvents.id, [...new Set([...remap.values()].flat())]), eq(ledgerEvents.type, "buy")))
    .orderBy(asc(ledgerEvents.date), sql`${ledgerEvents.executedAt} asc nulls last`, asc(ledgerEvents.id));
  for (const w of linked) {
    const next = remap.get(w.buy!)!;
    const first = targets.find((t) => next.includes(t.id));
    // ponytail: no buy among the superseding events (never seen) → the link keeps pointing at the superseded row.
    if (first) await tx.update(watchItems).set({ linkedBuyEventId: first.id }).where(eq(watchItems.id, w.id));
  }
}
