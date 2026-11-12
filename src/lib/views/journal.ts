// Server-only view module (same pattern as targets.ts): loaders resolve the actor and hand
// rows to the pure buildEntries().
//
// Redaction (owner decision): the journal is for signed-in actors only. Share-link viewers get
// no entries whatever hide-amounts says; signed-in hide-amounts actors read it (text is not an amount).
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { journalEntries, targets, watchItems } from "@/db/schema";
import { type Actor, can, requireActor } from "@/lib/auth/access";
import { MEMBER_EVENT_TYPES } from "@/lib/buckets/inherit";
import type { JournalKind, JournalSubject } from "@/lib/journal/kinds";
import { liveEvents } from "@/lib/ledger/lots";
import { isoInMarket, loadLedger } from "@/lib/ledger/queries";
import type { Currency, ISODate } from "@/lib/returns/types";
import type { TargetKind, TargetStatus } from "@/lib/targets/evaluate";
import { authorLabel } from "./targets";

/** What an entry is about, with enough to label it ("Buy on 15 Jan 2024 at ₹1,520.50"). */
export type SubjectRef =
  | { type: "buy_event"; id: string; event: "buy" | "opening"; date: ISODate; price: number; live: boolean }
  | { type: "watch_item"; id: string; date: ISODate; archived: boolean }
  | { type: "target"; id: string; kind: TargetKind; price: number; status: TargetStatus };

export interface JournalEntryDto {
  id: string;
  kind: JournalKind;
  body: string;
  author: string;
  createdAt: string;
  edited: boolean;
  /** Null when the subject row is gone (never expected: subjects are kept, not deleted). */
  subject: SubjectRef | null;
  canEdit: boolean;
}

export interface EntryRow {
  id: string;
  subjectType: JournalSubject;
  subjectId: string;
  kind: JournalKind;
  body: string;
  author: string;
  createdAt: Date;
  updatedAt: Date;
}

export const readsJournal = (actor: Actor) => actor.via !== "share-link";

/** Pure: rows (newest first) → DTOs for the actor. Every loader goes through here, so this is the share-link cut. */
export function buildEntries(rows: EntryRow[], subjects: Map<string, SubjectRef>, actor: Actor, ownerEmail: string | null): JournalEntryDto[] {
  if (!readsJournal(actor)) return [];
  const owner = ownerEmail?.toLowerCase() ?? null;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    body: r.body,
    author: authorLabel(r.author, actor, owner),
    createdAt: r.createdAt.toISOString(),
    // A save within a minute of writing is a quick fix, not an edit worth flagging.
    edited: r.updatedAt.getTime() - r.createdAt.getTime() > 60_000,
    subject: subjects.get(r.subjectId) ?? null,
    canEdit: can(actor, "edit_own", { by: r.author }),
  }));
}

export interface SymbolJournal {
  entries: JournalEntryDto[];
  /** Subjects a new entry can be about: live buys (newest first), the active watch item, open and resolved targets. */
  options: SubjectRef[];
  canWrite: boolean;
  /** False for share-link viewers: the page renders no journal section. */
  visible: boolean;
}

const entryCols = {
  id: journalEntries.id,
  subjectType: journalEntries.subjectType,
  subjectId: journalEntries.subjectId,
  kind: journalEntries.kind,
  body: journalEntries.body,
  author: journalEntries.author,
  createdAt: journalEntries.createdAt,
  updatedAt: journalEntries.updatedAt,
};

export async function getSymbolJournal(instrumentId: string, currency: Currency): Promise<SymbolJournal> {
  const actor = await requireActor();
  if (!readsJournal(actor)) return { entries: [], options: [], canWrite: false, visible: false };
  const [rows, ledger, watch, tgts] = await Promise.all([
    db
      .select(entryCols)
      .from(journalEntries)
      .where(and(eq(journalEntries.instrumentId, instrumentId), isNull(journalEntries.deletedAt)))
      .orderBy(desc(journalEntries.createdAt)),
    loadLedger(db, [instrumentId]),
    db.select().from(watchItems).where(eq(watchItems.instrumentId, instrumentId)).orderBy(desc(watchItems.addedAt)),
    db.select().from(targets).where(eq(targets.instrumentId, instrumentId)).orderBy(desc(targets.setAt)),
  ]);
  const live = new Set(liveEvents(ledger.events, ledger.supersessions).map((e) => e.id));
  const subjects = new Map<string, SubjectRef>();
  const buys = ledger.events
    .filter((e) => (MEMBER_EVENT_TYPES as readonly string[]).includes(e.type))
    .sort((a, b) => b.date.localeCompare(a.date));
  for (const e of buys)
    subjects.set(e.id, { type: "buy_event", id: e.id, event: e.type as "buy" | "opening", date: e.date, price: e.price, live: live.has(e.id) });
  for (const w of watch)
    subjects.set(w.id, { type: "watch_item", id: w.id, date: isoInMarket(w.addedAt, currency).slice(0, 10), archived: w.archivedAt != null });
  for (const t of tgts) subjects.set(t.id, { type: "target", id: t.id, kind: t.kind, price: Number(t.price), status: t.status });

  const canWrite = can(actor, "suggest");
  const options = canWrite
    ? [...subjects.values()].filter((s) =>
        s.type === "buy_event" ? s.live : s.type === "watch_item" ? !s.archived : s.status !== "cancelled",
      )
    : [];
  return { entries: buildEntries(rows, subjects, actor, process.env.OWNER_EMAIL ?? null), options, canWrite, visible: true };
}

/** Watchlist rows: each watch item's entries (newest first), for the row's journal sheet. */
export async function getWatchJournal(itemIds: string[]): Promise<{ byItem: Map<string, JournalEntryDto[]>; canWrite: boolean }> {
  const actor = await requireActor();
  if (!readsJournal(actor)) return { byItem: new Map(), canWrite: false };
  const rows = itemIds.length
    ? await db
        .select(entryCols)
        .from(journalEntries)
        .where(and(eq(journalEntries.subjectType, "watch_item"), inArray(journalEntries.subjectId, itemIds), isNull(journalEntries.deletedAt)))
        .orderBy(desc(journalEntries.createdAt))
    : [];
  const dtos = buildEntries(rows, new Map(), actor, process.env.OWNER_EMAIL ?? null);
  const byItem = new Map<string, JournalEntryDto[]>();
  rows.forEach((r, i) => byItem.set(r.subjectId, [...(byItem.get(r.subjectId) ?? []), dtos[i]]));
  return { byItem, canWrite: can(actor, "suggest") };
}
