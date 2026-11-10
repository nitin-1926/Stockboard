import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { instruments, journalEntries, priceLatest, targets } from "@/db/schema";
import { type Actor, can } from "@/lib/auth/access";
import { isoInMarket } from "@/lib/ledger/queries";
import { fetchLatestPrice } from "@/lib/market/instruments";
import { authorEmail } from "@/lib/watch/actions";
import { priceFromPct, type TargetKind, validateLevel } from "./evaluate";

// Target writes (U16). Each takes the actor and checks it here (testable without Next);
// src/app/(app)/targets/actions.ts only wraps them.
//   create            → suggest (owner, contributor); set_by is always the actor
//   edit, cancel      → edit_own on set_by (owner: any; contributor: own), pending only
// Editing never updates a row: it inserts the new target and cancels the old one with
// replaced_by, so a manager's original call stays in the history and the scorecard.
// Journal entries on the old target move to the new one in the same transaction.

export class TargetError extends Error {
  name = "TargetError";
}

type Target = typeof targets.$inferSelect;

export interface TargetFields {
  instrumentId: string;
  kind: TargetKind;
  mode: "abs" | "pct";
  /** abs: the price; pct: signed fraction of the current price (0.2 = +20%, −0.1 for a stop 10% below). */
  value: number;
  deadline?: string | null;
  note?: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (n: number) => String(Number(n.toFixed(6)));

/** The price the actor saw: price_latest (cron-fresh), else an on-demand quote. */
async function currentPrice(instrumentId: string) {
  const [i] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!i) throw new TargetError("Unknown symbol.");
  if (i.priceUnavailable) throw new TargetError(`${i.brokerSymbol} has no price, so a target can't be measured.`);
  const [p] = await db.select().from(priceLatest).where(eq(priceLatest.instrumentId, i.id));
  const price = p ? Number(p.price) : ((await fetchLatestPrice(i))?.price ?? null);
  if (price == null) throw new TargetError(`No current price for ${i.brokerSymbol} yet. Try again after the next price refresh.`);
  return { instrument: i, price };
}

/** Validates the fields against the current price → the row to insert (without set_by). */
async function resolve(f: TargetFields, now: Date) {
  if (f.kind !== "target" && f.kind !== "stop") throw new TargetError("Kind must be target or stop.");
  if (f.mode !== "abs" && f.mode !== "pct") throw new TargetError("Mode must be price or percent.");
  if (!Number.isFinite(f.value)) throw new TargetError("Enter a number.");
  const { instrument, price: current } = await currentPrice(f.instrumentId);
  const price = f.mode === "pct" ? priceFromPct(current, f.value) : f.value;
  const bad = validateLevel(f.kind, price, current);
  if (bad) throw new TargetError(bad);

  const deadline = f.deadline?.trim() || null;
  if (deadline) {
    const today = isoInMarket(now, instrument.currency).slice(0, 10);
    if (!ISO_DATE.test(deadline) || Number.isNaN(Date.parse(deadline))) throw new TargetError("Deadline must be a date.");
    if (deadline <= today) throw new TargetError("Deadline must be after today.");
  }
  const note = f.note?.trim().slice(0, 500) || null;
  return {
    instrumentId: instrument.id,
    kind: f.kind,
    price: str(price),
    inputMode: f.mode,
    pctValue: f.mode === "pct" ? str(f.value) : null,
    deadline,
    priceAtSet: str(current),
    setAt: now,
    note,
  };
}

export async function createTarget(actor: Actor, f: TargetFields, now = new Date()): Promise<Target> {
  if (!can(actor, "suggest")) throw new Error("Forbidden");
  const row = await resolve(f, now);
  const [t] = await db
    .insert(targets)
    .values({ ...row, setBy: authorEmail(actor) })
    .returning();
  return t;
}

async function loadPending(actor: Actor, id: string): Promise<Target> {
  const [t] = await db.select().from(targets).where(eq(targets.id, id));
  if (!t) throw new TargetError("Target not found.");
  if (!can(actor, "edit_own", { by: t.setBy })) throw new Error("Forbidden");
  if (t.status !== "pending") throw new TargetError("This target is already resolved and can't be changed.");
  return t;
}

const cancelledOn = async (t: Target, now: Date) => {
  const [i] = await db.select({ currency: instruments.currency }).from(instruments).where(eq(instruments.id, t.instrumentId));
  return isoInMarket(now, i.currency).slice(0, 10);
};

/** Edit = a new target (stamped with the editor, priced now) + the old one cancelled, pointing at it. */
export async function editTarget(
  actor: Actor,
  id: string,
  f: Omit<TargetFields, "instrumentId">,
  now = new Date(),
): Promise<Target> {
  const old = await loadPending(actor, id);
  const row = await resolve({ ...f, instrumentId: old.instrumentId }, now);
  const resolvedAt = await cancelledOn(old, now);
  return db.transaction(async (tx) => {
    const [next] = await tx
      .insert(targets)
      .values({ ...row, setBy: authorEmail(actor) })
      .returning();
    // Guarded on pending: if the EOD run resolved it meanwhile, the edit is refused and rolled back.
    const done = await tx
      .update(targets)
      .set({ status: "cancelled", resolvedAt, replacedBy: next.id })
      .where(and(eq(targets.id, id), eq(targets.status, "pending")))
      .returning({ id: targets.id });
    if (!done.length) throw new TargetError("This target was resolved in the meantime and can't be changed.");
    // The journal is a narrative of the call, so its entries follow the edit (due-reviews read the new target).
    await tx
      .update(journalEntries)
      .set({ subjectId: next.id })
      .where(and(eq(journalEntries.subjectType, "target"), eq(journalEntries.subjectId, id)));
    return next;
  });
}

export async function cancelTarget(actor: Actor, id: string, now = new Date()): Promise<void> {
  const t = await loadPending(actor, id);
  const resolvedAt = await cancelledOn(t, now);
  const done = await db
    .update(targets)
    .set({ status: "cancelled", resolvedAt })
    .where(and(eq(targets.id, id), eq(targets.status, "pending")))
    .returning({ id: targets.id });
  if (!done.length) throw new TargetError("This target was resolved in the meantime and can't be changed.");
}
