import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { journalEntries, ledgerEvents, ledgerSupersessions, targets, watchItems } from "@/db/schema";
import { type Actor, can } from "@/lib/auth/access";
import { MEMBER_EVENT_TYPES } from "@/lib/buckets/inherit";
import type { Tx } from "@/lib/ledger/queries";
import { authorEmail } from "@/lib/watch/actions";
import { JOURNAL_KINDS, JOURNAL_MAX_BODY, JOURNAL_SUBJECTS, type JournalKind, type JournalSubject } from "./kinds";

// Journal writes (U20). Each takes the actor and checks it here (testable without Next);
// the server actions in src/app/(app)/symbol/[id]/journal-actions.ts only wrap them.
//   create        → suggest (owner, contributor); author is always the actor
//   edit, delete  → edit_own on author (owner: any; contributor: own). Delete is soft.

export class JournalError extends Error {
  name = "JournalError";
}

type Entry = typeof journalEntries.$inferSelect;

function cleanBody(body: string) {
  const b = String(body ?? "").trim();
  if (!b) throw new JournalError("Write something first.");
  if (b.length > JOURNAL_MAX_BODY) throw new JournalError(`Keep it under ${JOURNAL_MAX_BODY} characters.`);
  return b;
}

/** The subject's instrument, or a JournalError. A buy must be a live buy/opening (not replaced). */
async function subjectInstrument(type: JournalSubject, id: string): Promise<string> {
  if (type === "buy_event") {
    const [e] = await db
      .select({ instrumentId: ledgerEvents.instrumentId, type: ledgerEvents.type })
      .from(ledgerEvents)
      .where(eq(ledgerEvents.id, id));
    if (!e || !(MEMBER_EVENT_TYPES as readonly string[]).includes(e.type)) throw new JournalError("That buy wasn't found.");
    const [gone] = await db.select().from(ledgerSupersessions).where(eq(ledgerSupersessions.supersededId, id)).limit(1);
    if (gone) throw new JournalError("That buy was replaced by a broker record. Reload the page and pick it again.");
    return e.instrumentId;
  }
  const table = type === "watch_item" ? watchItems : targets;
  const [r] = await db.select({ instrumentId: table.instrumentId }).from(table).where(eq(table.id, id));
  if (!r) throw new JournalError(type === "watch_item" ? "That watch item wasn't found." : "That target wasn't found.");
  return r.instrumentId;
}

export async function createEntry(
  actor: Actor,
  f: { subjectType: JournalSubject; subjectId: string; kind: JournalKind; body: string },
  now = new Date(),
): Promise<Entry> {
  if (!can(actor, "suggest")) throw new Error("Forbidden");
  if (!(JOURNAL_SUBJECTS as readonly string[]).includes(f.subjectType)) throw new JournalError("Pick what this note is about.");
  if (!(JOURNAL_KINDS as readonly string[]).includes(f.kind)) throw new JournalError("Pick thesis, review or note.");
  const body = cleanBody(f.body);
  const instrumentId = await subjectInstrument(f.subjectType, f.subjectId);
  const [row] = await db
    .insert(journalEntries)
    .values({ subjectType: f.subjectType, subjectId: f.subjectId, instrumentId, kind: f.kind, body, author: authorEmail(actor), createdAt: now, updatedAt: now })
    .returning();
  return row;
}

async function loadForEdit(actor: Actor, id: string) {
  const [e] = await db.select().from(journalEntries).where(and(eq(journalEntries.id, id), isNull(journalEntries.deletedAt)));
  if (!e) throw new JournalError("That entry wasn't found.");
  if (!can(actor, "edit_own", { by: e.author })) throw new Error("Forbidden");
  return e;
}

export async function editEntry(actor: Actor, id: string, body: string, now = new Date()): Promise<Entry> {
  await loadForEdit(actor, id);
  const [row] = await db.update(journalEntries).set({ body: cleanBody(body), updatedAt: now }).where(eq(journalEntries.id, id)).returning();
  return row;
}

export async function deleteEntry(actor: Actor, id: string, now = new Date()): Promise<Entry> {
  const e = await loadForEdit(actor, id);
  await db.update(journalEntries).set({ deletedAt: now }).where(eq(journalEntries.id, id));
  return e;
}

/**
 * REF_COPIERS entry: entries on a superseded buy/opening move to the FIRST superseding
 * buy/opening (by date). A journal is a narrative, so one opening replaced by three CSV
 * buys keeps one copy of its thesis, not three. No buy among the superseding events →
 * the entries stay where they are (still listed on the symbol page).
 */
export async function copyJournalRefs(tx: Tx, remap: Map<string, string[]>) {
  const moved = await tx
    .selectDistinct({ id: journalEntries.subjectId })
    .from(journalEntries)
    .where(and(eq(journalEntries.subjectType, "buy_event"), inArray(journalEntries.subjectId, [...remap.keys()])));
  if (!moved.length) return;
  const buys = await tx
    .select({ id: ledgerEvents.id })
    .from(ledgerEvents)
    .where(and(inArray(ledgerEvents.id, [...new Set(moved.flatMap((m) => remap.get(m.id)!))]), inArray(ledgerEvents.type, [...MEMBER_EVENT_TYPES])))
    .orderBy(asc(ledgerEvents.date), sql`${ledgerEvents.executedAt} asc nulls last`, asc(ledgerEvents.id));
  for (const m of moved) {
    const first = buys.find((b) => remap.get(m.id)!.includes(b.id));
    if (first)
      await tx
        .update(journalEntries)
        .set({ subjectId: first.id })
        .where(and(eq(journalEntries.subjectType, "buy_event"), eq(journalEntries.subjectId, m.id)));
  }
}
