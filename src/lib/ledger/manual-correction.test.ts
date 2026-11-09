import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, pool } from "@/db";
import {
  bucketMembers,
  buckets,
  corporateActions,
  holdingSnapshots,
  instruments,
  ledgerEvents,
  ledgerReviewQueue,
  ledgerSupersessions,
  priceLatest,
  syncRuns,
} from "@/db/schema";
import type { Actor } from "@/lib/auth/access";
import { retry } from "@/lib/market/yahoo";
import { buildBucketDetail, loadBucketsInputs } from "@/lib/views/buckets";
import { correctEvent, importConsoleCsv, ingestFills, ingestSnapshotRun, reclassifyAsBonus, resolveReviewItem } from "./ingest";
import { eventId, getLedgerState } from "./queries";

// Integration: real Neon DB, mocked network (Yahoo chart for the on-demand split check). Skips without DATABASE_URL.
describe.skipIf(!process.env.DATABASE_URL)("owner ledger corrections (Neon, mocked network)", { timeout: 120_000 }, () => {
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const prefix = `TEST_${tag}_`;
  const job = `test-correction-${tag}`;
  const owner: Actor = { kind: "owner", email: "owner@x.com", hideAmounts: false, via: "session" };
  const contributor: Actor = { kind: "contributor", email: "c@x.com", hideAmounts: false, via: "session" };
  const emptyChart = {
    chart: { result: [{ meta: { gmtoffset: 19800, currency: "INR" }, timestamp: [], indicators: { quote: [{}], adjclose: [{ adjclose: [] }] }, events: {} }] },
  };
  const fetchMock = vi.fn(async (input: string | URL) => {
    if (String(input).includes("/v8/finance/chart/")) return new Response(JSON.stringify(emptyChart), { status: 200 });
    throw new Error(`unexpected fetch ${input}`);
  });

  const mk = async (sym: string) =>
    (
      await db
        .insert(instruments)
        .values({ market: "IN", exchange: "NSE", brokerSymbol: prefix + sym, name: sym, currency: "INR" })
        .returning()
    )[0];
  const buy = (instrumentId: string, ref: string, day: string, qty: number, price: number) =>
    ingestFills("kite", [{ tradeId: `${tag}-${ref}`, instrumentId, side: "buy", qty, price, executedAt: `${day}T10:05:00+05:30` }]);
  const snapshot = async (instrumentId: string, takenAt: string, qty: number, avg: number, ltp: number | null = null) => {
    const [r] = await db.insert(syncRuns).values({ job, broker: "kite", status: "completed" }).returning();
    await db.insert(holdingSnapshots).values({
      runId: r.id,
      broker: "kite",
      instrumentId,
      takenAt: new Date(takenAt),
      qty: String(qty),
      avgPrice: String(avg),
      ltp: ltp == null ? null : String(ltp),
    });
    return ingestSnapshotRun(r.id);
  };
  const live = async (instrumentId: string) => {
    const rows = await db.select().from(ledgerEvents).where(eq(ledgerEvents.instrumentId, instrumentId));
    const links = await db.select().from(ledgerSupersessions);
    const gone = new Set(links.map((l) => l.supersededId));
    return rows.filter((r) => !gone.has(r.id));
  };
  const realized = async (id: string) => (await getLedgerState([id])).realized[id].inr;

  beforeEach(() => {
    retry.baseMs = 0;
    vi.stubGlobal("fetch", fetchMock);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    // Instruments cascade to events (→ links, memberships), snapshots, review items, corporate actions.
    await db.delete(instruments).where(like(instruments.brokerSymbol, `${prefix}%`));
    await db.delete(buckets).where(like(buckets.name, `${prefix}%`));
    await db.delete(syncRuns).where(eq(syncRuns.job, job));
    expect(await db.select().from(instruments).where(like(instruments.brokerSymbol, `${prefix}%`))).toHaveLength(0);
    await pool.end();
  });

  it("owner corrects an inferred sell price, then the buy: manual events supersede, realized P&L and bucket follow", async () => {
    const i = await mk("CORR");
    const [bucket] = await db.insert(buckets).values({ name: `${prefix}Picks`, createdBy: "owner@x.com" }).returning();
    await buy(i.id, "B1", "2004-01-05", 10, 100);
    const buyId = eventId(`fill:${tag}-B1`);
    await db.insert(bucketMembers).values({ bucketId: bucket.id, memberType: "buy_event", buyEventId: buyId, addedBy: "owner@x.com" });

    // Holdings drop 10 → 4 a week later with only the snapshot's ltp to price it: approximate inferred sell.
    await snapshot(i.id, "2004-01-12T15:45:00+05:30", 4, 100, 120);
    const sell = (await live(i.id)).find((e) => e.type === "sell")!;
    expect(sell).toMatchObject({ source: "inferred", approximate: true, price: "120" });
    expect(await realized(i.id)).toBeCloseTo(6 * 20);
    const [item] = await db.select().from(ledgerReviewQueue).where(eq(ledgerReviewQueue.instrumentId, i.id));
    expect(item).toMatchObject({ kind: "approximate_sell", resolvedAt: null });

    // A contributor can't; nothing is written.
    await expect(correctEvent(sell.id, { price: 130 }, contributor)).rejects.toThrow(/Forbidden/);
    expect((await live(i.id)).map((e) => e.source).sort()).toEqual(["fill", "inferred"]);

    const r = await correctEvent(sell.id, { price: 130 }, owner);
    expect(r.eventId).toBe(eventId(`manual:${sell.id}`));
    const after = await live(i.id);
    expect(after.find((e) => e.type === "sell")).toMatchObject({ source: "manual", price: "130", approximate: false, date: "2004-01-12" });
    expect(await realized(i.id)).toBeCloseTo(6 * 30);
    const [resolved] = await db.select().from(ledgerReviewQueue).where(eq(ledgerReviewQueue.id, item.id));
    expect(resolved.resolvedAt).not.toBeNull();
    // The replaced event can't be corrected again; the newer one can.
    await expect(correctEvent(sell.id, { price: 131 }, owner)).rejects.toThrow(/already replaced/);

    // Correct the buy: the manual buy carries the bucket membership, so bucket realized moves too.
    const m = await correctEvent(buyId, { price: 90 }, owner);
    // Bucket totals leave out open lots without a price.
    await db.insert(priceLatest).values({ instrumentId: i.id, price: "125", asOf: new Date(), source: "yahoo" });
    const members = await db.select().from(bucketMembers).where(eq(bucketMembers.bucketId, bucket.id));
    expect(members.map((x) => x.buyEventId).sort()).toEqual([buyId, m.eventId].sort());
    expect(await realized(i.id)).toBeCloseTo(6 * 40);
    const detail = buildBucketDetail(await loadBucketsInputs(new Date(), { bucketId: bucket.id }), owner, bucket.id)!;
    expect(detail.real.realizedInr).toBeCloseTo(240);
  });

  it("a moved date re-dates the event; an unchanged correction and a split are refused", async () => {
    const i = await mk("DATE");
    await buy(i.id, "D1", "2004-03-01", 5, 200);
    const id = eventId(`fill:${tag}-D1`);
    await expect(correctEvent(id, { price: 200 }, owner)).rejects.toThrow(/Nothing changed/);
    await expect(correctEvent(id, { date: "2004-13-40" }, owner)).rejects.toThrow(/YYYY-MM-DD/);
    await correctEvent(id, { date: "2004-02-27" }, owner);
    const [e] = await live(i.id);
    expect(e).toMatchObject({ source: "manual", date: "2004-02-27", price: "200" });
  });

  it("split → bonus reclassification: a zero-cost lot dated at allotment, corporate action flipped", async () => {
    const i = await mk("BONUS");
    await buy(i.id, "S1", "2004-02-02", 10, 100);
    await db.insert(corporateActions).values({ instrumentId: i.id, exDate: "2004-02-09", numerator: "2", denominator: "1", source: "test" });
    // Broker credits the doubled quantity two days after the ex-date, cost unchanged.
    await snapshot(i.id, "2004-02-11T15:45:00+05:30", 20, 50);
    const lotsBefore = (await getLedgerState([i.id])).openLots;
    expect(lotsBefore.map((l) => [l.qty, l.costPerShare])).toEqual([[20, 50]]);

    await expect(reclassifyAsBonus(i.id, "2004-02-09", contributor)).rejects.toThrow(/Forbidden/);
    const r = await reclassifyAsBonus(i.id, "2004-02-09", owner);
    expect(r).toEqual({ flipped: true, superseded: true });

    const lots = (await getLedgerState([i.id])).openLots;
    expect(lots.map((l) => [l.qty, l.costPerShare, l.openDate])).toEqual([
      [10, 100, "2004-02-02"],
      [10, 0, "2004-02-11"],
    ]);
    const [ca] = await db
      .select()
      .from(corporateActions)
      .where(and(eq(corporateActions.instrumentId, i.id), eq(corporateActions.exDate, "2004-02-09")));
    expect(ca).toMatchObject({ kind: "bonus", confirmedByOwner: true });
    await expect(reclassifyAsBonus(i.id, "2004-03-01", owner)).rejects.toThrow(/No split/);
  });

  const linksFrom = async (id: string) =>
    (await db.select().from(ledgerSupersessions).where(eq(ledgerSupersessions.supersededId, id))).map((l) => l.supersedingId);
  const oversells = async (id: string) =>
    db.select().from(ledgerReviewQueue).where(and(eq(ledgerReviewQueue.instrumentId, id), eq(ledgerReviewQueue.kind, "oversell")));
  const fillOf = (instrumentId: string, ref: string, side: "buy" | "sell", at: string, qty: number, price: number) =>
    ingestFills("kite", [{ tradeId: `${tag}-${ref}`, instrumentId, side, qty, price, executedAt: at }]);

  it("a broker fill after a manual correction of an inferred trade supersedes the correction: no double count, refs follow", async () => {
    const i = await mk("LATEFILL");
    const [bucket] = await db.insert(buckets).values({ name: `${prefix}Late`, createdBy: "owner@x.com" }).returning();
    await buy(i.id, "L0", "2004-01-05", 10, 100);
    await snapshot(i.id, "2004-01-06T15:45:00+05:30", 10, 100); // matches the ledger; a later residual is a trade, not an opening

    // Inferred buy of 5 (holdings 10 → 15), put in a bucket, then the owner fixes its price.
    await snapshot(i.id, "2004-01-12T15:45:00+05:30", 15, 110);
    const infBuy = (await live(i.id)).find((e) => e.source === "inferred")!;
    await db.insert(bucketMembers).values({ bucketId: bucket.id, memberType: "buy_event", buyEventId: infBuy.id, addedBy: "owner@x.com" });
    const manBuy = (await correctEvent(infBuy.id, { price: 128 }, owner)).eventId;

    // Inferred sell of 6 (15 → 9), owner fixes its price.
    await snapshot(i.id, "2004-01-20T15:45:00+05:30", 9, 110, 140);
    const infSell = (await live(i.id)).find((e) => e.source === "inferred")!;
    const manSell = (await correctEvent(infSell.id, { price: 141 }, owner)).eventId;

    // The broker's fills for both trades arrive later.
    await fillOf(i.id, "LB", "buy", "2004-01-12T10:05:00+05:30", 5, 129);
    await fillOf(i.id, "LS", "sell", "2004-01-20T11:00:00+05:30", 6, 142);
    const [fillBuy, fillSell] = [eventId(`fill:${tag}-LB`), eventId(`fill:${tag}-LS`)];

    expect(await linksFrom(manBuy)).toEqual([fillBuy]);
    expect(await linksFrom(manSell)).toEqual([fillSell]);
    expect((await getLedgerState([i.id])).positions[i.id].qty).toBe(9);
    expect(await oversells(i.id)).toEqual([]);
    const members = async () => (await db.select().from(bucketMembers).where(eq(bucketMembers.bucketId, bucket.id))).map((m) => m.buyEventId);
    expect(await members()).toContain(fillBuy);
    expect((await live(i.id)).map((e) => e.source).sort()).toEqual(["fill", "fill", "fill"]);

    // Re-sending the fills is a no-op.
    const before = (await members()).length;
    expect(await fillOf(i.id, "LB", "buy", "2004-01-12T10:05:00+05:30", 5, 129)).toEqual({ inserted: 0, superseded: 0 });
    expect(await fillOf(i.id, "LS", "sell", "2004-01-20T11:00:00+05:30", 6, 142)).toEqual({ inserted: 0, superseded: 0 });
    expect(await members()).toHaveLength(before);
    expect((await getLedgerState([i.id])).positions[i.id].qty).toBe(9);
  });

  it("a Console CSV row after a manual correction of an inferred sell supersedes the correction; re-import is a no-op", async () => {
    const i = await mk("LATECSV");
    await buy(i.id, "C0", "2004-01-05", 10, 100);
    await snapshot(i.id, "2004-01-12T15:45:00+05:30", 4, 100, 120);
    const infSell = (await live(i.id)).find((e) => e.source === "inferred")!;
    const manSell = (await correctEvent(infSell.id, { price: 130 }, owner)).eventId;

    const csv = [
      "symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time",
      `${prefix}LATECSV,INE000000000,2004-01-12,NSE,EQ,EQ,sell,false,6.000000,131.000000,${tag}C1,1,2004-01-12T11:00:00`,
    ].join("\n");
    expect(await importConsoleCsv(csv, owner)).toEqual({ inserted: 1, superseded: 1, unexplained: [] });
    expect(await linksFrom(manSell)).toEqual([eventId(`csv:${tag}C1`)]);
    expect((await getLedgerState([i.id])).positions[i.id].qty).toBe(4);
    expect(await oversells(i.id)).toEqual([]);
    expect(await importConsoleCsv(csv, owner)).toEqual({ inserted: 0, superseded: 0, unexplained: [] });
    expect((await getLedgerState([i.id])).positions[i.id].qty).toBe(4);
  });

  it("the Console CSV rows for corrected fills supersede the corrections: CSV wins, refs follow, re-import is a no-op", async () => {
    const i = await mk("FILLCSV");
    const [bucket] = await db.insert(buckets).values({ name: `${prefix}FillCsv`, createdBy: "owner@x.com" }).returning();
    await fillOf(i.id, "FB", "buy", "2004-01-05T10:05:00+05:30", 10, 100);
    await fillOf(i.id, "FS", "sell", "2004-01-12T11:00:00+05:30", 6, 120);
    await snapshot(i.id, "2004-01-12T15:45:00+05:30", 4, 100);
    const [fillBuy, fillSell] = [eventId(`fill:${tag}-FB`), eventId(`fill:${tag}-FS`)];
    await db.insert(bucketMembers).values({ bucketId: bucket.id, memberType: "buy_event", buyEventId: fillBuy, addedBy: "owner@x.com" });
    const manBuy = (await correctEvent(fillBuy, { price: 99 }, owner)).eventId;
    const manSell = (await correctEvent(fillSell, { price: 121 }, owner)).eventId;

    const csv = [
      "symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time",
      `${prefix}FILLCSV,INE000000000,2004-01-05,NSE,EQ,EQ,buy,false,10.000000,100.500000,${tag}-FB,1,2004-01-05T10:05:00`,
      `${prefix}FILLCSV,INE000000000,2004-01-12,NSE,EQ,EQ,sell,false,6.000000,120.500000,${tag}-FS,2,2004-01-12T11:00:00`,
    ].join("\n");
    expect(await importConsoleCsv(csv, owner)).toEqual({ inserted: 2, superseded: 2, unexplained: [] });
    const [csvBuy, csvSell] = [eventId(`csv:${tag}-FB`), eventId(`csv:${tag}-FS`)];
    expect(await linksFrom(manBuy)).toEqual([csvBuy]);
    expect(await linksFrom(manSell)).toEqual([csvSell]);
    expect((await live(i.id)).map((e) => e.id).sort()).toEqual([csvBuy, csvSell].sort());
    expect((await getLedgerState([i.id])).positions[i.id].qty).toBe(4);
    expect(await oversells(i.id)).toEqual([]);
    const members = (await db.select().from(bucketMembers).where(eq(bucketMembers.bucketId, bucket.id))).map((m) => m.buyEventId);
    expect(members).toContain(csvBuy);

    expect(await importConsoleCsv(csv, owner)).toEqual({ inserted: 0, superseded: 0, unexplained: [] });
    expect((await getLedgerState([i.id])).positions[i.id].qty).toBe(4);
  });

  it("mark resolved / ignored closes an item once, owner only", async () => {
    const i = await mk("ITEM");
    const [item] = await db.insert(ledgerReviewQueue).values({ instrumentId: i.id, kind: "unexplained", detail: { message: "x" } }).returning();
    await expect(resolveReviewItem(item.id, "ignored", contributor)).rejects.toThrow(/Forbidden/);
    await resolveReviewItem(item.id, "ignored", owner);
    const [row] = await db.select().from(ledgerReviewQueue).where(eq(ledgerReviewQueue.id, item.id));
    expect(row).toMatchObject({ resolvedBy: "owner@x.com", detail: { message: "x", resolution: "ignored" } });
    await expect(resolveReviewItem(item.id, "resolved", owner)).rejects.toThrow(/Already resolved/);
  });
});
