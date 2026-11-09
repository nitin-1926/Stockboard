import { createHash } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { corporateActions, ledgerEvents, ledgerSupersessions } from "@/db/schema";
import { replay, type ReplayResult } from "./lots";
import type { CorporateAction, Currency, EventSource, LedgerEvent, Supersession } from "./types";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** The pool client or an open transaction. */
export type Q = typeof db | Tx;
type EventRow = typeof ledgerEvents.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DB id for an event. Pure code uses id = sourceRef for new events; stored rows
 * already have uuids. A name-based (v5-style) uuid of the sourceRef means link
 * rows can be planned before insert and a re-ingest maps to the same row.
 */
export function eventId(idOrRef: string): string {
  if (UUID.test(idOrRef)) return idOrRef;
  const h = createHash("sha1").update(`ledger:${idOrRef}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Market time zone by currency: takenAt/executedAt keep the market's offset so slice(0, 10) is the local date. */
const TZ: Record<Currency, string> = { INR: "Asia/Kolkata", USD: "America/New_York" };

export function isoInMarket(d: Date, currency: Currency): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ[currency],
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  const off = p.timeZoneName === "GMT" ? "+00:00" : p.timeZoneName.slice(3);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}

// numeric columns are strings; the pure core works in float64 (src/lib/returns/types.ts).
export const toEvent = (r: EventRow): LedgerEvent => ({
  id: r.id,
  instrumentId: r.instrumentId,
  type: r.type,
  date: r.date,
  executedAt: r.executedAt ? isoInMarket(r.executedAt, r.currency) : undefined,
  qty: Number(r.qty),
  price: Number(r.price),
  currency: r.currency,
  fxRateInr: Number(r.fxRateInr),
  source: r.source as EventSource,
  sourceRef: r.sourceRef,
  approximate: r.approximate,
  ratio: r.ratioNum && r.ratioDen ? { num: Number(r.ratioNum), den: Number(r.ratioDen) } : undefined,
  exDate: r.exDate ?? undefined,
});

/** Every event (superseded included) for the instruments, plus the link rows among them. */
export async function loadLedger(q: Q, instrumentIds?: string[]) {
  if (instrumentIds && !instrumentIds.length) return { events: [] as LedgerEvent[], supersessions: [] as Supersession[] };
  const rows = await q
    .select()
    .from(ledgerEvents)
    .where(instrumentIds ? inArray(ledgerEvents.instrumentId, instrumentIds) : undefined);
  const ids = rows.map((r) => r.id);
  const links = ids.length
    ? await q
        .select({ supersededId: ledgerSupersessions.supersededId, supersedingId: ledgerSupersessions.supersedingId })
        .from(ledgerSupersessions)
        .where(inArray(ledgerSupersessions.supersededId, ids))
    : [];
  return { events: rows.map(toEvent), supersessions: links };
}

export async function loadActions(q: Q, instrumentIds: string[]): Promise<CorporateAction[]> {
  if (!instrumentIds.length) return [];
  const rows = await q.select().from(corporateActions).where(inArray(corporateActions.instrumentId, instrumentIds));
  return rows.map((r) => ({
    instrumentId: r.instrumentId,
    exDate: r.exDate,
    ratio: { num: Number(r.numerator), den: Number(r.denominator) },
    kind: r.kind,
  }));
}

/**
 * Lots, realized P&L and broker-convention positions from live (non-superseded)
 * events. Lots carry instrumentId; realized/positions are keyed by it. Used by U13 views.
 */
export async function getLedgerState(instrumentIds?: string[]): Promise<ReplayResult> {
  const { events, supersessions } = await loadLedger(db, instrumentIds);
  return replay(events, supersessions);
}
