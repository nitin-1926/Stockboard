import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { BUCKET_COLORS, type BucketColor, bucketMembers, buckets, ledgerEvents, ledgerSupersessions, watchItems } from "@/db/schema";
import { type Actor, can } from "@/lib/auth/access";
import { authorEmail } from "@/lib/watch/actions";
import { MEMBER_EVENT_TYPES } from "./inherit";

// Bucket writes (U15). Each takes the actor and checks it here (testable without Next);
// src/app/(app)/buckets/actions.ts only wraps them.
//   create bucket, add member      → create_bucket / suggest (owner, contributor)
//   edit bucket, remove member     → edit_own (owner: all; contributor: what they created)
//   delete (archive) bucket        → delete_bucket (owner only)

export class BucketError extends Error {
  name = "BucketError";
}

type Bucket = typeof buckets.$inferSelect;
export interface BucketFields {
  name: string;
  description?: string | null;
  color?: string;
}

const isUniqueViolation = (e: unknown) =>
  [(e as { code?: string })?.code, (e as { cause?: { code?: string } })?.cause?.code].includes("23505");

function clean(f: BucketFields) {
  const name = f.name.trim().replace(/\s+/g, " ");
  if (!name || name.length > 60) throw new BucketError("Name must be 1-60 characters.");
  const description = f.description?.trim() || null;
  if (description && description.length > 280) throw new BucketError("Description must be at most 280 characters.");
  const color = (f.color ?? "chart-1") as BucketColor;
  if (!BUCKET_COLORS.includes(color)) throw new BucketError("Unknown color.");
  return { name, description, color };
}

async function liveBucket(id: string): Promise<Bucket> {
  const [b] = await db.select().from(buckets).where(and(eq(buckets.id, id), isNull(buckets.archivedAt)));
  if (!b) throw new BucketError("That bucket no longer exists.");
  return b;
}

async function named<T>(name: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if (isUniqueViolation(e)) throw new BucketError(`A bucket named "${name}" already exists.`);
    throw e;
  }
}

export async function createBucket(actor: Actor, fields: BucketFields): Promise<Bucket> {
  if (!can(actor, "create_bucket")) throw new Error("Forbidden");
  const f = clean(fields);
  const by = authorEmail(actor);
  return named(f.name, async () => (await db.insert(buckets).values({ ...f, createdBy: by }).returning())[0]);
}

export async function updateBucket(actor: Actor, id: string, fields: BucketFields): Promise<void> {
  const b = await liveBucket(id);
  if (!can(actor, "edit_own", { by: b.createdBy })) throw new Error("Forbidden");
  const f = clean(fields);
  await named(f.name, () => db.update(buckets).set(f).where(eq(buckets.id, id)));
}

/** Delete = archive (members stay with the archived row). Owner only. */
export async function archiveBucket(actor: Actor, id: string, now = new Date()): Promise<void> {
  if (!can(actor, "delete_bucket")) throw new Error("Forbidden");
  await liveBucket(id);
  await db.update(buckets).set({ archivedAt: now }).where(eq(buckets.id, id));
}

export type MemberRef = { buyEventId: string } | { watchItemId: string };

/** Adds a live buy/opening event or an active watch item. Re-adding is a no-op. */
export async function addMember(actor: Actor, bucketId: string, ref: MemberRef): Promise<{ created: boolean }> {
  if (!can(actor, "suggest")) throw new Error("Forbidden");
  await liveBucket(bucketId);
  const by = authorEmail(actor);
  if ("buyEventId" in ref) {
    const [e] = await db
      .select({ id: ledgerEvents.id })
      .from(ledgerEvents)
      .where(and(eq(ledgerEvents.id, ref.buyEventId), inArray(ledgerEvents.type, [...MEMBER_EVENT_TYPES])));
    if (!e) throw new BucketError("Only a buy (or opening holding) can be added.");
    const [gone] = await db.select().from(ledgerSupersessions).where(eq(ledgerSupersessions.supersededId, e.id)).limit(1);
    if (gone) throw new BucketError("That lot was replaced by newer trade data. Pick it again from the list.");
    const r = await db
      .insert(bucketMembers)
      .values({ bucketId, memberType: "buy_event", buyEventId: e.id, addedBy: by })
      .onConflictDoNothing()
      .returning({ id: bucketMembers.id });
    return { created: r.length > 0 };
  }
  const [w] = await db
    .select({ id: watchItems.id })
    .from(watchItems)
    .where(and(eq(watchItems.id, ref.watchItemId), isNull(watchItems.archivedAt)));
  if (!w) throw new BucketError("That watch item is archived or gone.");
  const r = await db
    .insert(bucketMembers)
    .values({ bucketId, memberType: "watch_item", watchItemId: w.id, addedBy: by })
    .onConflictDoNothing()
    .returning({ id: bucketMembers.id });
  return { created: r.length > 0 };
}

export async function removeMember(actor: Actor, memberId: string): Promise<void> {
  const [m] = await db.select().from(bucketMembers).where(eq(bucketMembers.id, memberId));
  if (!m) return;
  if (!can(actor, "edit_own", { by: m.addedBy })) throw new Error("Forbidden");
  await db.delete(bucketMembers).where(eq(bucketMembers.id, memberId));
}
