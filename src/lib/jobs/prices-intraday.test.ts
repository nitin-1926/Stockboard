import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, pool } from "@/db";
import { holdingSnapshots, instruments, ledgerEvents, priceLatest, syncRuns, targets, watchItems } from "@/db/schema";
import { eventId } from "@/lib/ledger/queries";
import { retry } from "@/lib/market/yahoo";
import { pricesIntraday, trackedInstruments } from "./prices-intraday";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe.skipIf(!process.env.DATABASE_URL)("prices-intraday job (Neon, mocked Yahoo)", { timeout: 120_000 }, () => {
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const prefix = `TEST_${tag}_`;
  const job = `test-prices-${tag}`;
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/v7/finance/spark")) {
      const symbols = decodeURIComponent(new URL(url).searchParams.get("symbols") ?? "").split(",");
      return json({
        spark: { result: symbols.map((s) => ({ symbol: s, response: [{ meta: { regularMarketPrice: 123, regularMarketTime: 1_800_000_000 } }] })) },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  const mk = async (sym: string, over: Partial<typeof instruments.$inferInsert> = {}) => {
    const [row] = await db
      .insert(instruments)
      .values({ market: "IN", exchange: "NSE", brokerSymbol: prefix + sym, yahooSymbol: prefix + sym, name: sym, currency: "INR", ...over })
      .returning();
    return row;
  };
  let set: Record<string, typeof instruments.$inferSelect>;

  beforeEach(() => {
    retry.baseMs = 0;
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.delete(instruments).where(like(instruments.brokerSymbol, `${prefix}%`));
    await db.delete(syncRuns).where(eq(syncRuns.job, job));
    await pool.end();
  });

  it("tracked set = held (ledger) ∪ watched ∪ pending targets ∪ benchmarks; test snapshot runs never count", async () => {
    set = {
      held: await mk("HELD"),
      snap: await mk("SNAP"),
      watch: await mk("WATCH"),
      archived: await mk("ARCH"),
      target: await mk("TGT"),
      bench: await mk("BENCH", { isBenchmark: true }),
      none: await mk("NONE"),
      sold: await mk("SOLD"),
    };
    const ev = (i: { id: string }, type: "opening" | "sell", qty: number) => {
      const ref = `test:${prefix}${randomUUID()}`;
      return { id: eventId(ref), instrumentId: i.id, type, date: "2026-01-02", qty: String(qty), price: "10", currency: "INR" as const, fxRateInr: "1", source: "opening" as const, sourceRef: ref };
    };
    await db.insert(ledgerEvents).values([ev(set.held, "opening", 5), ev(set.sold, "opening", 5), ev(set.sold, "sell", 5)]);
    const [run] = await db.insert(syncRuns).values({ job, broker: "kite", status: "completed" }).returning();
    await db.insert(holdingSnapshots).values({ runId: run.id, broker: "kite", instrumentId: set.snap.id, takenAt: new Date(), qty: "3", avgPrice: "10" });
    await db.insert(watchItems).values([
      { instrumentId: set.watch.id, createdBy: "owner@example.com" },
      { instrumentId: set.archived.id, createdBy: "owner@example.com", archivedAt: new Date() },
    ]);
    await db.insert(targets).values({ instrumentId: set.target.id, kind: "target", price: "20", setBy: "owner@example.com", priceAtSet: "10" });

    const ids = new Set((await trackedInstruments("IN")).map((i) => i.id));
    for (const k of ["held", "watch", "target", "bench"]) expect(ids.has(set[k].id), k).toBe(true);
    // "snap" sits only in this test's snapshot run (job "test-…"), which latestSnapshotRunIds ignores.
    for (const k of ["snap", "archived", "none", "sold"]) expect(ids.has(set[k].id), k).toBe(false);
    expect((await trackedInstruments("US")).some((i) => i.id === set.bench.id)).toBe(false);
  });

  it("closed markets are skipped without a network call", async () => {
    const r = await pricesIntraday(new Date("2026-11-14T12:00:00Z")); // Saturday
    expect(r.counts).toEqual({ skipped: "IN closed, US closed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an open market refreshes its tracked set only; the closed one is skipped", async () => {
    const only = Object.values(set).map((i) => i.id);
    // Wed 10:30 IST (NSE open), 00:00 in New York (closed).
    const r = await pricesIntraday(new Date("2026-11-11T05:00:00Z"), { only });
    expect(r.counts).toMatchObject({ skipped: "US closed", IN_yahoo: 4, IN_fallback: 0 });
    const priced = new Set((await db.select().from(priceLatest).where(inArray(priceLatest.instrumentId, only))).map((p) => p.instrumentId));
    expect(priced).toEqual(new Set([set.held.id, set.watch.id, set.target.id, set.bench.id]));
  });
});
