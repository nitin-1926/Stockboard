import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, pool } from "@/db";
import { holdingSnapshots, instruments, ledgerEvents, syncRuns, watchItems } from "@/db/schema";
import { ingestFills, ingestSnapshotRun } from "@/lib/ledger/ingest";
import { eventId } from "@/lib/ledger/queries";
import { retry } from "@/lib/market/yahoo";

// Integration: real Neon DB, mocked network (Yahoo chart for the on-demand split check).
describe.skipIf(!process.env.DATABASE_URL)("watch item ↔ buy links (Neon, mocked network)", { timeout: 120_000 }, () => {
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const prefix = `TEST_${tag}_`;
  const job = `test-watch-${tag}`;
  const emptyChart = {
    chart: { result: [{ meta: { gmtoffset: 19800, currency: "INR" }, timestamp: [], indicators: { quote: [{}] }, events: {} }] },
  };
  const fetchMock = vi.fn(async (input: string | URL) => {
    if (String(input).includes("/v8/finance/chart/")) return new Response(JSON.stringify(emptyChart), { status: 200 });
    throw new Error(`unexpected fetch ${input}`);
  });

  const mk = async (sym: string) => {
    const [i] = await db
      .insert(instruments)
      .values({ market: "IN", exchange: "NSE", brokerSymbol: prefix + sym, name: sym, currency: "INR" })
      .returning();
    const [w] = await db
      .insert(watchItems)
      .values({ instrumentId: i.id, addedAt: new Date("2026-11-01T04:00:00Z"), priceAtAdd: "100", createdBy: "owner@x.com" })
      .returning();
    return { i, w };
  };
  const fill = (id: string, ref: string, day: string, price: number) => ({
    tradeId: `${tag}-${ref}`,
    instrumentId: id,
    side: "buy" as const,
    qty: 5,
    price,
    executedAt: `${day}T10:05:00+05:30`,
  });
  const linkOf = async (id: string) => (await db.select().from(watchItems).where(eq(watchItems.id, id)))[0].linkedBuyEventId;

  beforeEach(() => {
    retry.baseMs = 0;
    vi.stubGlobal("fetch", fetchMock);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    // Cascades to watch items, ledger events, snapshots, review items.
    await db.delete(instruments).where(like(instruments.brokerSymbol, `${prefix}%`));
    await db.delete(syncRuns).where(eq(syncRuns.job, job));
    await pool.end();
  });

  it("links the first buy on/after the add date with its price and date; a second buy doesn't relink", async () => {
    const { i, w } = await mk("LINK");
    await ingestFills("kite", [fill(i.id, "EARLY", "2026-10-28", 90)]); // before it was watched
    expect(await linkOf(w.id)).toBeNull();

    await ingestFills("kite", [fill(i.id, "B1", "2026-11-03", 104)]);
    const first = eventId(`fill:${tag}-B1`);
    expect(await linkOf(w.id)).toBe(first);
    const [buy] = await db.select().from(ledgerEvents).where(eq(ledgerEvents.id, first));
    expect(buy).toMatchObject({ price: "104", date: "2026-11-03", type: "buy" });

    await ingestFills("kite", [fill(i.id, "B2", "2026-11-04", 110)]);
    expect(await linkOf(w.id)).toBe(first);
  });

  it("an archived item is not linked", async () => {
    const { i, w } = await mk("ARCH");
    await db.update(watchItems).set({ archivedAt: new Date("2026-11-02T00:00:00Z") }).where(eq(watchItems.id, w.id));
    await ingestFills("kite", [fill(i.id, "ARCH1", "2026-11-03", 104)]);
    expect(await linkOf(w.id)).toBeNull();
  });

  it("a linked inferred buy superseded by a fill moves the link to the fill", async () => {
    const { i, w } = await mk("SUP");
    const run = async (takenAt: string, qty: number, avg: number) => {
      const [r] = await db.insert(syncRuns).values({ job, broker: "kite", status: "completed" }).returning();
      await db.insert(holdingSnapshots).values({
        runId: r.id,
        broker: "kite",
        instrumentId: i.id,
        takenAt: new Date(takenAt),
        qty: String(qty),
        avgPrice: String(avg),
      });
      return r.id;
    };
    await ingestSnapshotRun(await run("2026-11-02T10:15:00Z", 10, 100)); // opening: not a buy, no link
    expect(await linkOf(w.id)).toBeNull();
    const r2 = await run("2026-11-03T10:15:00Z", 15, 110);
    await ingestSnapshotRun(r2);
    const inferred = (await db.select().from(ledgerEvents).where(eq(ledgerEvents.instrumentId, i.id))).find(
      (e) => e.source === "inferred",
    )!;
    expect(await linkOf(w.id)).toBe(inferred.id);

    expect(await ingestFills("kite", [fill(i.id, "SUP1", "2026-11-03", 129.5)])).toEqual({ inserted: 1, superseded: 1 });
    expect(await linkOf(w.id)).toBe(eventId(`fill:${tag}-SUP1`));
  });
});
