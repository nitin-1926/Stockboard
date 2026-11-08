import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, between, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, pool } from "@/db";
import { corporateActions, dividends, fxDaily, instruments, priceLatest, pricesDaily } from "@/db/schema";
import { ensureFxRange } from "./fx";
import { backfillHistory, enrichInstrument, refreshLatest } from "./prices";
import { seedBenchmarks } from "./seed";
import { crumbStore, retry } from "./yahoo";

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
const json = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

// Integration: real Neon DB, mocked network. Skips without DATABASE_URL (CI).
describe.skipIf(!process.env.DATABASE_URL)("prices (Neon, mocked Yahoo)", () => {
  const prefix = `TEST_${randomUUID().slice(0, 8)}_`;
  const fetchMock = vi.fn();
  const make = async (sym: string, extra: Partial<typeof instruments.$inferInsert> = {}) => {
    const [row] = await db
      .insert(instruments)
      .values({
        market: "IN",
        exchange: "NSE",
        brokerSymbol: prefix + sym,
        yahooSymbolOverride: `${prefix}${sym}.NS`,
        name: sym,
        currency: "INR",
        ...extra,
      })
      .returning();
    return row;
  };
  const latest = (id: string) => db.select().from(priceLatest).where(eq(priceLatest.instrumentId, id));

  beforeEach(() => {
    retry.baseMs = 0;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.delete(instruments).where(like(instruments.brokerSymbol, `${prefix}%`));
    await db.delete(fxDaily).where(between(fxDaily.date, "2001-01-01", "2001-01-31"));
    await pool.end();
  });

  it("429 → retries, then the injected fallback prices it with source=mcp", async () => {
    const i = await make("RL");
    fetchMock.mockResolvedValue(json("Too Many Requests", 429));
    const fallback = vi.fn(async (list: { id: string }[]) => new Map(list.map((x) => [x.id, 123.45])));
    const r = await refreshLatest([i], { fallback });
    expect(fetchMock).toHaveBeenCalledTimes(3); // spark retried; per-symbol chart skipped once limited
    expect(fallback).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ yahoo: 0, fallback: 1 });
    const [row] = await latest(i.id);
    expect(row).toMatchObject({ price: "123.45", source: "mcp" });
  });

  it("404 → price_unavailable, no zero price, last stored price kept for transient failures", async () => {
    const gone = await make("GONE");
    const flaky = await make("FLAKY");
    await db.insert(priceLatest).values({ instrumentId: flaky.id, price: "50", asOf: new Date(), source: "yahoo" });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/spark")) return json({ spark: { result: [], error: null } });
      if (url.includes("GONE")) return json(fixture("chart-404.json"), 404);
      return json("boom", 500);
    });
    const r = await refreshLatest([gone, flaky]);
    expect(r).toEqual({ yahoo: 0, fallback: 0, unavailable: 1, kept: 1 });
    expect(await latest(gone.id)).toEqual([]);
    expect((await latest(flaky.id))[0].price).toBe("50");
    const flags = await db
      .select({ id: instruments.id, u: instruments.priceUnavailable })
      .from(instruments)
      .where(inArray(instruments.id, [gone.id, flaky.id]));
    expect(Object.fromEntries(flags.map((f) => [f.id, f.u]))).toEqual({ [gone.id]: true, [flaky.id]: false });
  });

  it("spark hit → price_latest source=yahoo and clears price_unavailable", async () => {
    const i = await make("OK", { priceUnavailable: true });
    const body = JSON.parse(fixture("spark.json"));
    body.spark.result[0].symbol = `${prefix}OK.NS`;
    fetchMock.mockResolvedValue(json(body));
    await refreshLatest([i]);
    expect((await latest(i.id))[0]).toMatchObject({ price: "353.61", source: "yahoo" });
    const [row] = await db.select().from(instruments).where(eq(instruments.id, i.id));
    expect(row.priceUnavailable).toBe(false);
  });

  it("backfill stores raw prices + events; a new event on a short fetch triggers a range=max refetch", async () => {
    const i = await make("SPLIT");
    fetchMock.mockImplementation(async () => json(fixture("chart-split-10-1.json")));
    const r = await backfillHistory(i, { range: "5d" });
    expect(r).toMatchObject({ refetched: true, newEvents: 2, bars: 4 });
    // "max" goes out as period1=0 (Yahoo's range=max is monthly).
    expect(fetchMock.mock.calls.map(([u]) => new URL(u).searchParams.get("range") ?? new URL(u).searchParams.get("period1"))).toEqual(["5d", "0"]);

    const bars = await db.select().from(pricesDaily).where(eq(pricesDaily.instrumentId, i.id)).orderBy(pricesDaily.date);
    expect(bars.map((b) => b.close)).toEqual(["1000", "1010", "99", "101.5"]);
    const [ca] = await db.select().from(corporateActions).where(eq(corporateActions.instrumentId, i.id));
    expect(ca).toMatchObject({ exDate: "2026-03-04", kind: "split", numerator: "10", denominator: "1", confirmedByOwner: false });
    const [dv] = await db.select().from(dividends).where(eq(dividends.instrumentId, i.id));
    expect(dv).toMatchObject({ exDate: "2026-03-02", amountPerShare: "5", currency: "INR" });

    // Same events again → nothing new, no refetch.
    fetchMock.mockClear();
    expect(await backfillHistory(i, { range: "5d" })).toMatchObject({ refetched: false, newEvents: 0 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("backfill 404 → price_unavailable, nothing written", async () => {
    const i = await make("DEAD");
    fetchMock.mockResolvedValue(json(fixture("chart-404.json"), 404));
    expect(await backfillHistory(i)).toEqual({ bars: 0, newEvents: 0, refetched: false });
    const [row] = await db.select().from(instruments).where(eq(instruments.id, i.id));
    expect(row.priceUnavailable).toBe(true);
  });

  it("enrich never overwrites an owner-overridden sector", async () => {
    const i = await make("ENR", { sector: "Mine", sectorOverridden: true });
    vi.spyOn(crumbStore, "load").mockResolvedValue({ crumb: "c", cookie: "A3=x" });
    fetchMock.mockResolvedValue(
      json({ quoteSummary: { result: [{ assetProfile: { sector: "Energy", industry: "Oil" }, price: { marketCap: { raw: 999 } } }] } }),
    );
    await enrichInstrument(i);
    const [row] = await db.select().from(instruments).where(eq(instruments.id, i.id));
    expect(row).toMatchObject({ sector: "Mine", industry: null, marketCap: "999" });
  });

  it("ensureFxRange fills a range (incl. weekend) with one series call, then is a no-op", async () => {
    // 2001-01-06/07 is a weekend.
    fetchMock.mockResolvedValue(
      json({ rates: { "2001-01-04": { INR: 46.5 }, "2001-01-05": { INR: 46.6 }, "2001-01-08": { INR: 46.7 } } }),
    );
    expect(await ensureFxRange("2001-01-05", "2001-01-08")).toBe(4);
    expect(fetchMock.mock.calls[0][0]).toContain("/v1/2000-12-29..2001-01-08?");
    const rows = await db.select().from(fxDaily).where(and(between(fxDaily.date, "2001-01-05", "2001-01-08"))).orderBy(fxDaily.date);
    expect(rows.map((r) => [r.date, r.usdInr, r.source])).toEqual([
      ["2001-01-05", "46.6", "frankfurter"],
      ["2001-01-06", "46.6", "frankfurter_ffill"],
      ["2001-01-07", "46.6", "frankfurter_ffill"],
      ["2001-01-08", "46.7", "frankfurter"],
    ]);
    fetchMock.mockClear();
    expect(await ensureFxRange("2001-01-05", "2001-01-08")).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("seedBenchmarks is idempotent: exactly NIFTYBEES + SPY flagged as benchmarks", async () => {
    await seedBenchmarks();
    await seedBenchmarks();
    const rows = await db
      .select({ s: instruments.brokerSymbol, y: instruments.yahooSymbol })
      .from(instruments)
      .where(and(eq(instruments.isBenchmark, true), inArray(instruments.brokerSymbol, ["NIFTYBEES", "SPY"])));
    expect(rows.sort((a, b) => a.s.localeCompare(b.s))).toEqual([
      { s: "NIFTYBEES", y: "NIFTYBEES.NS" },
      { s: "SPY", y: "SPY" },
    ]);
  });
});
