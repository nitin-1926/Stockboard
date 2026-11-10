import { and, inArray } from "drizzle-orm";
import { bucketMembers, ledgerEvents } from "@/db/schema";
import { replay } from "@/lib/ledger/lots";
import { loadLedger, type Tx } from "@/lib/ledger/queries";
import { effDate, type LedgerEvent } from "@/lib/ledger/types";

// Bucket membership follows buy events (U15). Both run inside the ledger ingest
// transaction (src/lib/ledger/ingest.ts `commit`), after the ref copies.

/** Event types that can be bucket members: a buy, or an opening (pre-ledger holding). */
export const MEMBER_EVENT_TYPES = ["buy", "opening"] as const;
const isMemberType = (e: LedgerEvent) => (MEMBER_EVENT_TYPES as readonly string[]).includes(e.type);

type Membership = { bucketId: string; addedBy: string };

/**
 * A new buy inherits the buckets of the instrument's lots that are open just before it
 * (replay of the live ledger up to its date, without it). Fully sold, then re-bought →
 * nothing open → no inheritance. The inherited row keeps the source row's author, so
 * whoever tagged the old lot can also remove the new one.
 *
 * `skip`: events that replace a superseded one. They get exactly their predecessor's
 * memberships from `copyBucketMembers`, so a bucket the owner removed isn't re-added.
 */
export async function inheritBuckets(tx: Tx, insertedEventIds: string[], skip: ReadonlySet<string> = new Set()) {
  const ids = insertedEventIds.filter((id) => !skip.has(id));
  if (!ids.length) return;
  const fresh = await tx
    .select({ instrumentId: ledgerEvents.instrumentId })
    .from(ledgerEvents)
    .where(and(inArray(ledgerEvents.id, ids), inArray(ledgerEvents.type, [...MEMBER_EVENT_TYPES])));
  if (!fresh.length) return;

  const { events, supersessions } = await loadLedger(tx, [...new Set(fresh.map((f) => f.instrumentId))]);
  const rows = await tx
    .select({ eventId: bucketMembers.buyEventId, bucketId: bucketMembers.bucketId, addedBy: bucketMembers.addedBy })
    .from(bucketMembers)
    .where(inArray(bucketMembers.buyEventId, events.map((e) => e.id)));
  const byEvent = new Map<string, Membership[]>();
  for (const r of rows) byEvent.set(r.eventId!, [...(byEvent.get(r.eventId!) ?? []), r]);

  const wanted = new Set(ids);
  const newBuys = events
    .filter((e) => wanted.has(e.id) && isMemberType(e))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.executedAt ?? "").localeCompare(b.executedAt ?? ""));
  // In date order, so a batch of buys chains: the second sees what the first inherited.
  for (const buy of newBuys) {
    const before = events.filter((e) => e.instrumentId === buy.instrumentId && e.id !== buy.id && effDate(e) <= buy.date);
    const inherited = new Map<string, Membership>();
    for (const lot of replay(before, supersessions).openLots)
      for (const m of byEvent.get(lot.eventId) ?? []) if (!inherited.has(m.bucketId)) inherited.set(m.bucketId, m);
    if (!inherited.size) continue;
    await tx
      .insert(bucketMembers)
      .values([...inherited.values()].map((m) => ({ bucketId: m.bucketId, memberType: "buy_event" as const, buyEventId: buy.id, addedBy: m.addedBy })))
      .onConflictDoNothing();
    byEvent.set(buy.id, [...inherited.values()]);
  }
}

/**
 * REF_COPIERS entry: memberships of a superseded buy/opening are copied onto EVERY
 * superseding buy/opening (one opening → three CSV buys all stay in the bucket). The
 * old rows stay with the superseded event; views only read live events.
 */
export async function copyBucketMembers(tx: Tx, remap: Map<string, string[]>) {
  const rows = await tx.select().from(bucketMembers).where(inArray(bucketMembers.buyEventId, [...remap.keys()]));
  if (!rows.length) return;
  const targets = new Set(
    (
      await tx
        .select({ id: ledgerEvents.id })
        .from(ledgerEvents)
        .where(and(inArray(ledgerEvents.id, [...new Set([...remap.values()].flat())]), inArray(ledgerEvents.type, [...MEMBER_EVENT_TYPES])))
    ).map((t) => t.id),
  );
  const values = rows.flatMap((r) =>
    (remap.get(r.buyEventId!) ?? [])
      .filter((t) => targets.has(t))
      .map((t) => ({ bucketId: r.bucketId, memberType: "buy_event" as const, buyEventId: t, addedBy: r.addedBy, addedAt: r.addedAt })),
  );
  if (values.length) await tx.insert(bucketMembers).values(values).onConflictDoNothing();
}
