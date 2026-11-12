import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, pool } from "@/db";
import { holdingSnapshots, instruments, journalEntries, syncRuns, targets, watchItems } from "@/db/schema";
import type { Actor } from "@/lib/auth/access";
import { importConsoleCsv, ingestSnapshotRun } from "@/lib/ledger/ingest";
import { eventId } from "@/lib/ledger/queries";
import { retry } from "@/lib/market/yahoo";
import { createEntry, deleteEntry, editEntry, JournalError } from "./actions";

const fixture = readFileSync(new URL("../ledger/__fixtures__/console-tradebook.csv", import.meta.url), "utf8");

// Integration: real Neon DB, mocked network (Yahoo chart for the on-demand split check during ingest).
describe.skipIf(!process.env.DATABASE_URL)("journal actions (Neon)", { timeout: 120_000 }, () => {
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const prefix = `TEST_${tag}_`;
  const job = `test-journal-${tag}`;
  const owner: Actor = { kind: "owner", email: "owner@x.com", hideAmounts: false, via: "session" };
  const contributor: Actor = { kind: "contributor", email: "c@x.com", hideAmounts: false, via: "session" };
  const viewer: Actor = { kind: "viewer", hideAmounts: true, via: "share-link" };
  const emptyChart = {
    chart: { result: [{ meta: { gmtoffset: 19800, currency: "INR" }, timestamp: [], indicators: { quote: [{}], adjclose: [{ adjclose: [] }] }, events: {} }] },
  };
  const fetchMock = vi.fn(async (input: string | URL) => {
    if (String(input).includes("/v8/finance/chart/")) return new Response(JSON.stringify(emptyChart), { status: 200 });
    throw new Error(`unexpected fetch ${input}`);
  });
  let instrumentId = "";
  let watchId = "";

  beforeAll(async () => {
    const [i] = await db
      .insert(instruments)
      .values({ market: "IN", exchange: "NSE", brokerSymbol: `${prefix}INFY`, name: "Journal test", currency: "INR" })
      .returning();
    instrumentId = i.id;
    const [w] = await db.insert(watchItems).values({ instrumentId, priceAtAdd: "1500", createdBy: "owner@x.com" }).returning();
    watchId = w.id;
  });
  beforeEach(() => {
    retry.baseMs = 0;
    vi.stubGlobal("fetch", fetchMock);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    // Cascades to watch items, targets, ledger events, snapshots and journal entries.
    await db.delete(instruments).where(like(instruments.brokerSymbol, `${prefix}%`));
    await db.delete(syncRuns).where(eq(syncRuns.job, job));
    expect(await db.select().from(journalEntries).where(eq(journalEntries.instrumentId, instrumentId))).toHaveLength(0);
    await pool.end();
  });

  it("a viewer can't create; a missing subject or an empty body is refused", async () => {
    await expect(createEntry(viewer, { subjectType: "watch_item", subjectId: watchId, kind: "thesis", body: "no" })).rejects.toThrow("Forbidden");
    await expect(
      createEntry(owner, { subjectType: "target", subjectId: randomUUID(), kind: "thesis", body: "x" }),
    ).rejects.toBeInstanceOf(JournalError);
    await expect(createEntry(owner, { subjectType: "watch_item", subjectId: watchId, kind: "thesis", body: "   " })).rejects.toBeInstanceOf(JournalError);
  });

  it("a contributor's entry is attributed to them (instrument filled from the subject)", async () => {
    const e = await createEntry(contributor, { subjectType: "watch_item", subjectId: watchId, kind: "thesis", body: "  Margins turning.  " });
    expect(e).toMatchObject({ author: "c@x.com", instrumentId, body: "Margins turning.", subjectType: "watch_item", kind: "thesis", deletedAt: null });
  });

  it("a contributor can't edit or delete the owner's entry; can edit and delete their own; the owner can edit anyone's", async () => {
    const [t] = await db
      .insert(targets)
      .values({ instrumentId, kind: "target", price: "1800", priceAtSet: "1500", setBy: "owner@x.com" })
      .returning();
    const mine = await createEntry(owner, { subjectType: "target", subjectId: t.id, kind: "thesis", body: "Owner's call." });
    await expect(editEntry(contributor, mine.id, "hijack")).rejects.toThrow("Forbidden");
    await expect(deleteEntry(contributor, mine.id)).rejects.toThrow("Forbidden");

    const theirs = await createEntry(contributor, { subjectType: "target", subjectId: t.id, kind: "note", body: "First take." });
    expect((await editEntry(contributor, theirs.id, "Second take.")).body).toBe("Second take.");
    expect((await editEntry(owner, theirs.id, "Owner fixed a typo.")).author).toBe("c@x.com");
    await deleteEntry(contributor, theirs.id);
    const [gone] = await db.select().from(journalEntries).where(eq(journalEntries.id, theirs.id));
    expect(gone.deletedAt).not.toBeNull(); // soft delete
    await expect(editEntry(owner, theirs.id, "back")).rejects.toBeInstanceOf(JournalError);
    expect((await db.select().from(journalEntries).where(eq(journalEntries.id, mine.id)))[0].body).toBe("Owner's call.");
  });

  it("an opening superseded by Console CSV buys → its thesis moves to the FIRST CSV buy, once", async () => {
    const [r] = await db.insert(syncRuns).values({ job, broker: "kite", status: "completed" }).returning();
    await db
      .insert(holdingSnapshots)
      .values({ runId: r.id, broker: "kite", instrumentId, takenAt: new Date("2026-11-09T10:15:00Z"), qty: "10", avgPrice: "1626.4" });
    await ingestSnapshotRun(r.id);
    const opening = eventId(`opening:kite:${instrumentId}`);
    const e = await createEntry(owner, { subjectType: "buy_event", subjectId: opening, kind: "thesis", body: "Bought for the buyback." });

    const text = fixture.replaceAll("INFY,", `${prefix}INFY,`).replace(/,(5\d{7}),/g, `,$1${tag},`);
    expect(await importConsoleCsv(text, owner)).toMatchObject({ superseded: 1 });
    const onBuys = await db.select().from(journalEntries).where(eq(journalEntries.subjectType, "buy_event"));
    const ours = onBuys.filter((x) => x.instrumentId === instrumentId);
    expect(ours).toHaveLength(1); // moved, not copied
    expect(ours[0]).toMatchObject({ id: e.id, subjectId: eventId(`csv:56789012${tag}`), body: "Bought for the buyback." });

    // The opening is now replaced: a new entry on it is refused.
    await expect(createEntry(owner, { subjectType: "buy_event", subjectId: opening, kind: "note", body: "late" })).rejects.toBeInstanceOf(JournalError);
  });
});
