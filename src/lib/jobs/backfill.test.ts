import { randomUUID } from "node:crypto";
import { inArray, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, pool } from "@/db";
import { dividends, instruments, ledgerEvents, pricesDaily } from "@/db/schema";
import { eventId } from "@/lib/ledger/queries";
import { ensureFxRange, today } from "@/lib/market/fx";
import { retry } from "@/lib/market/yahoo";
import { runBackfill } from "./backfill";

// ensureFxRange would fill real fx_daily dates from a mocked series; assert the call instead.
vi.mock("@/lib/market/fx", async (orig) => ({
  ...(await orig<typeof import("@/lib/market/fx")>()),
  ensureFxRange: vi.fn(async () => 7),
}));

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const DATES = ["2003-03-03", "2003-03-04", "2003-03-05"];
const ts = (d: string) => Date.parse(`${d}T09:30:00Z`) / 1000;

describe.skipIf(!process.env.DATABASE_URL)("backfill job (Neon, mocked Yahoo)", { timeout: 120_000 }, () => {
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const prefix = `TEST_${tag}_`;
  let failOnce: string | null = null;
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/v8/finance/chart/")) {
      const sym = decodeURIComponent(url.split("/chart/")[1].split("?")[0]);
      if (sym === failOnce) {
        failOnce = null;
        throw new Error("simulated timeout");
      }
      return json({
        chart: {
          result: [
            {
              meta: { symbol: sym, gmtoffset: 19800, currency: "INR" },
              timestamp: DATES.map(ts),
              indicators: { quote: [{ close: [10, 11, 12] }], adjclose: [{ adjclose: [10, 11, 12] }] },
              events: { dividends: { [ts(DATES[1])]: { date: ts(DATES[1]), amount: 0.5 } } },
            },
          ],
        },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  beforeEach(() => {
    retry.baseMs = 0;
    vi.stubGlobal("fetch", fetchMock);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.delete(instruments).where(like(instruments.brokerSymbol, `${prefix}%`));
    await pool.end();
  });

  it("3 chunks: resumes from the last completed cursor after an interruption; benchmarks and sold positions included", async () => {
    const mk = async (sym: string, market: "IN" | "US", isBenchmark = false) =>
      (
        await db
          .insert(instruments)
          .values({ market, exchange: "X", brokerSymbol: prefix + sym, yahooSymbol: prefix + sym, name: sym, currency: market === "IN" ? "INR" : "USD", isBenchmark })
          .returning()
      )[0];
    const list = [await mk("A", "IN"), await mk("B", "IN"), await mk("C", "US"), await mk("SOLD", "IN"), await mk("BENCH", "US", true)];
    const ev = (i: (typeof list)[number], type: "opening" | "sell", date: string) => {
      const ref = `test:${prefix}${randomUUID()}`;
      return { id: eventId(ref), instrumentId: i.id, type, date, qty: "5", price: "10", currency: i.currency, fxRateInr: i.currency === "USD" ? "45" : "1", source: "opening" as const, sourceRef: ref };
    };
    await db.insert(ledgerEvents).values([
      ev(list[0], "opening", "2003-03-03"),
      ev(list[1], "opening", "2003-04-01"),
      ev(list[2], "opening", "2003-05-01"),
      ev(list[3], "opening", "2003-02-14"), // earliest ledger date
      ev(list[3], "sell", "2003-03-01"), // sold out: not tracked, still backfilled
    ]);
    const only = list.map((i) => i.id);
    const order = [...list].sort((a, b) => a.id.localeCompare(b.id));
    const opts = { only, chunkSize: 2 };

    const c1 = await runBackfill(null, opts);
    expect(c1).toMatchObject({ done: false, cursor: { after: order[1].id }, counts: { instruments: 2, remaining: 3, bars: 6, fx: 7 } });
    expect(ensureFxRange).toHaveBeenCalledWith("2003-02-14", today());

    failOnce = order[2].yahooSymbol; // chunk 2 dies on its first instrument
    await expect(runBackfill(c1.cursor as { after: string }, opts)).rejects.toThrow("simulated timeout");

    // The handler hands the next run the last COMPLETED cursor, i.e. c1's.
    const c2 = await runBackfill(c1.cursor as { after: string }, opts);
    expect(c2).toMatchObject({ done: false, cursor: { after: order[3].id }, counts: { instruments: 2, remaining: 1, fx: 0 } });
    const c3 = await runBackfill(c2.cursor as { after: string }, opts);
    expect(c3).toMatchObject({ done: true, cursor: undefined, counts: { instruments: 1, remaining: 0 } });
    expect(ensureFxRange).toHaveBeenCalledTimes(1);

    const bars = await db.select().from(pricesDaily).where(inArray(pricesDaily.instrumentId, only));
    for (const i of list) expect(bars.filter((b) => b.instrumentId === i.id).map((b) => b.date).sort(), i.name).toEqual(DATES);
    const divs = await db.select().from(dividends).where(inArray(dividends.instrumentId, only));
    expect(divs).toHaveLength(list.length);
  });
});
