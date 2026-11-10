import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, pool } from "@/db";
import { instruments, journalEntries, priceLatest, pricesDaily, targets } from "@/db/schema";
import type { Actor } from "@/lib/auth/access";
import { createEntry } from "@/lib/journal/actions";
import { dueReviews } from "@/lib/journal/due-reviews";
import { cancelTarget, createTarget, editTarget, TargetError } from "./actions";
import { evaluatePendingTargets } from "./evaluate-job";

// Integration: real Neon DB. Permission matrix + edit history + the evaluate job.
describe.skipIf(!process.env.DATABASE_URL)("target actions (Neon)", { timeout: 60_000 }, () => {
  const prefix = `TEST_${randomUUID().slice(0, 8).toUpperCase()}_`;
  const owner: Actor = { kind: "owner", email: "owner@x.com", hideAmounts: false, via: "session" };
  const contributor: Actor = { kind: "contributor", email: "c@x.com", hideAmounts: false, via: "session" };
  const viewer: Actor = { kind: "viewer", email: "v@x.com", hideAmounts: false, via: "session" };
  let instrumentId = "";
  const byId = async (id: string) => (await db.select().from(targets).where(eq(targets.id, id)))[0];

  beforeAll(async () => {
    const [i] = await db
      .insert(instruments)
      .values({ market: "IN", exchange: "NSE", brokerSymbol: `${prefix}TGT`, name: "Target test", currency: "INR" })
      .returning();
    instrumentId = i.id;
    await db.insert(priceLatest).values({ instrumentId, price: "1000", asOf: new Date(), source: "yahoo" });
  });
  afterAll(async () => {
    await db.delete(instruments).where(like(instruments.brokerSymbol, `${prefix}%`)); // cascades targets, prices
    await pool.end();
  });

  it("contributor create stamps set_by with their email (a spoofed set_by is ignored); % mode stores both", async () => {
    const t = await createTarget(contributor, {
      instrumentId,
      kind: "target",
      mode: "pct",
      value: 0.2,
      setBy: "owner@x.com",
    } as Parameters<typeof createTarget>[1]);
    expect(t).toMatchObject({ setBy: "c@x.com", price: "1200", pctValue: "0.2", inputMode: "pct", priceAtSet: "1000", status: "pending" });
  });

  it("a viewer can't create; a target below the price or a stop above it is refused", async () => {
    await expect(createTarget(viewer, { instrumentId, kind: "target", mode: "abs", value: 1100 })).rejects.toThrow("Forbidden");
    await expect(createTarget(owner, { instrumentId, kind: "target", mode: "abs", value: 990 })).rejects.toBeInstanceOf(TargetError);
    await expect(createTarget(owner, { instrumentId, kind: "stop", mode: "abs", value: 1010 })).rejects.toBeInstanceOf(TargetError);
    await expect(
      createTarget(owner, { instrumentId, kind: "stop", mode: "abs", value: 900, deadline: "2020-01-01" }),
    ).rejects.toBeInstanceOf(TargetError);
  });

  it("a contributor can't cancel or edit the owner's target; can cancel their own", async () => {
    const mine = await createTarget(owner, { instrumentId, kind: "stop", mode: "abs", value: 900 });
    await expect(cancelTarget(contributor, mine.id)).rejects.toThrow("Forbidden");
    await expect(editTarget(contributor, mine.id, { kind: "stop", mode: "abs", value: 950 })).rejects.toThrow("Forbidden");
    const theirs = await createTarget(contributor, { instrumentId, kind: "stop", mode: "abs", value: 880 });
    await cancelTarget(contributor, theirs.id);
    expect((await byId(theirs.id)).status).toBe("cancelled");
    expect((await byId(mine.id)).status).toBe("pending");
  });

  it("edit creates a new target and cancels the old one with replaced_by", async () => {
    const old = await createTarget(contributor, { instrumentId, kind: "target", mode: "abs", value: 1300, note: "first call" });
    const next = await editTarget(owner, old.id, { kind: "target", mode: "abs", value: 1400, deadline: "2099-12-31" });
    expect(next).toMatchObject({ price: "1400", deadline: "2099-12-31", setBy: "owner@x.com", status: "pending" });
    const was = await byId(old.id);
    expect(was).toMatchObject({ status: "cancelled", replacedBy: next.id, price: "1300", note: "first call", setBy: "c@x.com" });
    expect(was.resolvedAt).not.toBeNull();
  });

  it("edit re-points the old target's journal entries to the new one, so its thesis makes the new target due", async () => {
    const a = await createTarget(owner, { instrumentId, kind: "target", mode: "abs", value: 1250 });
    const thesis = await createEntry(owner, { subjectType: "target", subjectId: a.id, kind: "thesis", body: "margin expansion" });
    const b = await editTarget(owner, a.id, { kind: "target", mode: "abs", value: 1260 });
    const [moved] = await db.select().from(journalEntries).where(eq(journalEntries.id, thesis.id));
    expect(moved).toMatchObject({ subjectType: "target", subjectId: b.id });

    // B hits today: its thesis (written on A) makes it due for review.
    const now = new Date();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
    await db.update(targets).set({ status: "hit", resolvedAt: today }).where(eq(targets.id, b.id));
    const entries = await db.select().from(journalEntries).where(eq(journalEntries.instrumentId, instrumentId));
    const t = await byId(b.id);
    const due = dueReviews(
      [{ id: t.id, instrumentId, symbol: "X", currency: "INR", kind: t.kind, price: Number(t.price), status: t.status, deadline: t.deadline, resolvedAt: t.resolvedAt, missPct: null }],
      entries,
      now,
    );
    expect(due.map((d) => d.targetId)).toEqual([b.id]);
  });

  it("evaluate job persists a hit from a seeded bar; a resolved target can't be edited or cancelled", async () => {
    const t = await createTarget(owner, { instrumentId, kind: "target", mode: "abs", value: 1500 }, new Date("2026-11-02T05:00:00Z"));
    await db.insert(pricesDaily).values({ instrumentId, date: "2026-11-09", high: "1510", low: "1470", close: "1490" });
    const r = await evaluatePendingTargets(new Date("2026-11-11T12:00:00Z"), "IN");
    expect(r.resolved.hit).toBeGreaterThanOrEqual(1);
    expect(await byId(t.id)).toMatchObject({ status: "hit", resolvedAt: "2026-11-09", resolvedPrice: "1510", bestPrice: "1510" });
    // Idempotent: a re-run leaves it as it is.
    await evaluatePendingTargets(new Date("2026-11-11T12:00:00Z"), "IN");
    expect((await byId(t.id)).status).toBe("hit");
    await expect(editTarget(owner, t.id, { kind: "target", mode: "abs", value: 1600 })).rejects.toBeInstanceOf(TargetError);
    await expect(cancelTarget(owner, t.id)).rejects.toBeInstanceOf(TargetError);
  });
});
