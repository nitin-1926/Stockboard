import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, pool } from "@/db";
import { bucketMembers, buckets, instruments, ledgerEvents, watchItems } from "@/db/schema";
import type { Actor } from "@/lib/auth/access";
import { addMember, archiveBucket, BucketError, createBucket, removeMember, updateBucket } from "./actions";

// Integration: real Neon DB. Permission matrix for bucket writes (owner decision in tasks/todo.md).
describe.skipIf(!process.env.DATABASE_URL)("bucket actions (Neon)", { timeout: 60_000 }, () => {
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const prefix = `TEST_${tag}_`;
  const owner: Actor = { kind: "owner", email: "owner@x.com", hideAmounts: false, via: "session" };
  const contributor: Actor = { kind: "contributor", email: "c@x.com", hideAmounts: false, via: "session" };
  const viewer: Actor = { kind: "viewer", email: "v@x.com", hideAmounts: false, via: "session" };
  let buyId = "";
  let sellId = "";
  let watchId = "";

  beforeAll(async () => {
    const [i] = await db
      .insert(instruments)
      .values({ market: "IN", exchange: "NSE", brokerSymbol: `${prefix}ACT`, name: "ACT", currency: "INR" })
      .returning();
    const ev = (type: "buy" | "sell", ref: string) => ({
      instrumentId: i.id,
      type,
      date: "2026-01-12",
      qty: "5",
      price: "100",
      currency: "INR" as const,
      fxRateInr: "1",
      source: "manual" as const,
      sourceRef: `${prefix}${ref}`,
    });
    [{ id: buyId }, { id: sellId }] = await db.insert(ledgerEvents).values([ev("buy", "B"), ev("sell", "S")]).returning();
    [{ id: watchId }] = await db.insert(watchItems).values({ instrumentId: i.id, priceAtAdd: "100", createdBy: "owner@x.com" }).returning();
  });
  afterAll(async () => {
    await db.delete(instruments).where(like(instruments.brokerSymbol, `${prefix}%`));
    await db.delete(buckets).where(like(buckets.name, `${prefix}%`));
    await pool.end();
  });

  it("contributor creates a bucket, stamped with their email; a viewer can't", async () => {
    const b = await createBucket(contributor, { name: `${prefix}Self`, color: "chart-2" });
    expect(b).toMatchObject({ createdBy: "c@x.com", color: "chart-2", archivedAt: null });
    await expect(createBucket(viewer, { name: `${prefix}Nope` })).rejects.toThrow("Forbidden");
  });

  it("names are unique case-insensitively among live buckets", async () => {
    await createBucket(owner, { name: `${prefix}Manager picks` });
    await expect(createBucket(contributor, { name: `${prefix}MANAGER PICKS` })).rejects.toBeInstanceOf(BucketError);
  });

  it("viewer adding a member is rejected; contributor adds a buy and a watch item; a sell is refused", async () => {
    const b = await createBucket(owner, { name: `${prefix}Add` });
    await expect(addMember(viewer, b.id, { buyEventId: buyId })).rejects.toThrow("Forbidden");
    expect(await addMember(contributor, b.id, { buyEventId: buyId })).toEqual({ created: true });
    expect(await addMember(contributor, b.id, { buyEventId: buyId })).toEqual({ created: false });
    expect(await addMember(contributor, b.id, { watchItemId: watchId })).toEqual({ created: true });
    await expect(addMember(owner, b.id, { buyEventId: sellId })).rejects.toBeInstanceOf(BucketError);
  });

  it("contributor can remove their own member but not the owner's; can't edit the owner's bucket", async () => {
    const b = await createBucket(owner, { name: `${prefix}Remove` });
    await addMember(owner, b.id, { buyEventId: buyId });
    await addMember(contributor, b.id, { watchItemId: watchId });
    const rows = await db.select().from(bucketMembers).where(eq(bucketMembers.bucketId, b.id));
    const ownerRow = rows.find((r) => r.addedBy === "owner@x.com")!;
    const mine = rows.find((r) => r.addedBy === "c@x.com")!;
    await expect(removeMember(contributor, ownerRow.id)).rejects.toThrow("Forbidden");
    await removeMember(contributor, mine.id);
    expect((await db.select().from(bucketMembers).where(eq(bucketMembers.bucketId, b.id))).map((r) => r.id)).toEqual([ownerRow.id]);
    await expect(updateBucket(contributor, b.id, { name: `${prefix}Renamed` })).rejects.toThrow("Forbidden");
  });

  it("deleting (archiving) a bucket is owner-only; archiving frees the name", async () => {
    const b = await createBucket(contributor, { name: `${prefix}Gone` });
    await expect(archiveBucket(contributor, b.id)).rejects.toThrow("Forbidden");
    await updateBucket(contributor, b.id, { name: `${prefix}Gone`, description: "own bucket, editable" });
    await archiveBucket(owner, b.id);
    const [row] = await db.select().from(buckets).where(eq(buckets.id, b.id));
    expect(row.archivedAt).not.toBeNull();
    expect(row.description).toBe("own bucket, editable");
    await expect(addMember(owner, b.id, { buyEventId: buyId })).rejects.toBeInstanceOf(BucketError);
    expect((await createBucket(owner, { name: `${prefix}gone` })).id).not.toBe(b.id);
  });
});
