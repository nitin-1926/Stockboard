import { randomUUID } from "node:crypto";
import { and, between, eq, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, pool } from "@/db";
import { fxDaily, instruments, ledgerEvents, ledgerReviewQueue, ledgerSupersessions, targets } from "@/db/schema";
import { eventId } from "@/lib/ledger/queries";
import { retry } from "@/lib/market/yahoo";
import { runEod } from "./eod";

// refreshFx re-pulls the real last 10 days: with the mocked network it would overwrite real
// fx_daily rows. Everything else in fx.ts stays real (ensureFxRange only fills 2003 gaps here).
vi.mock("@/lib/market/fx", async (orig) => ({
  ...(await orig<typeof import("@/lib/market/fx")>()),
  refreshFx: vi.fn(async () => 0),
}));

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
type Market = "IN" | "US";
type BarSpec = [date: string, close: number, high?: number, low?: number];
type ChartSpec = { market: Market; bars: BarSpec[]; divs?: [date: string, amount: number][] };

// Exchange-local 15:00 IST / 10:30 EDT, so the parsed local date is the given date.
const ts = (d: string, m: Market) => Date.parse(`${d}T${m === "IN" ? "09:30" : "14:30"}:00Z`) / 1000;
const chartBody = (sym: string, c: ChartSpec) => ({
  chart: {
    result: [
      {
        meta: { symbol: sym, gmtoffset: c.market === "IN" ? 19800 : -14400, currency: c.market === "IN" ? "INR" : "USD" },
        timestamp: c.bars.map(([d]) => ts(d, c.market)),
        indicators: {
          quote: [
            {
              open: c.bars.map(([, cl]) => cl),
              high: c.bars.map(([, cl, h]) => h ?? cl),
              low: c.bars.map(([, cl, , l]) => l ?? cl),
              close: c.bars.map(([, cl]) => cl),
              volume: c.bars.map(() => 1000),
            },
          ],
          adjclose: [{ adjclose: c.bars.map(([, cl]) => cl) }],
        },
        events: {
          dividends: Object.fromEntries((c.divs ?? []).map(([d, a]) => [ts(d, c.market), { date: ts(d, c.market), amount: a }])),
        },
      },
    ],
  },
});

// Frankfurter business days (weekends absent).
const FX: Record<string, number> = { "2003-06-02": 46.2, "2003-06-03": 46.3, "2003-06-04": 46.4, "2003-06-05": 46.45, "2003-06-06": 46.5 };

// Integration: real Neon, mocked network. Each runEod is scoped to the test's TEST_ instruments
// (`only`) because the dev DB holds real benchmarks. Dates are in 2003, far from real data.
describe.skipIf(!process.env.DATABASE_URL)("EOD job (Neon, mocked network)", { timeout: 120_000 }, () => {
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const prefix = `TEST_${tag}_`;
  const charts: Record<string, ChartSpec> = {};
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("frankfurter"))
      return json({ rates: Object.fromEntries(Object.entries(FX).map(([d, r]) => [d, { INR: r }])) });
    if (url.includes("/v8/finance/chart/")) {
      const sym = decodeURIComponent(url.split("/chart/")[1].split("?")[0]);
      if (charts[sym]) return json(chartBody(sym, charts[sym]));
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  const mk = async (sym: string, market: Market, chart?: Omit<ChartSpec, "market">) => {
    const [row] = await db
      .insert(instruments)
      .values({
        market,
        exchange: market === "IN" ? "NSE" : "US",
        brokerSymbol: prefix + sym,
        yahooSymbol: prefix + sym,
        name: sym,
        currency: market === "IN" ? "INR" : "USD",
      })
      .returning();
    if (chart) charts[prefix + sym] = { market, ...chart };
    return row;
  };
  const ev = async (
    i: typeof instruments.$inferSelect,
    type: "opening" | "buy" | "sell",
    date: string,
    qty: number,
    price: number,
    over: Partial<typeof ledgerEvents.$inferInsert> = {},
  ) => {
    const ref = over.sourceRef ?? `test:${prefix}${randomUUID()}`;
    const [row] = await db
      .insert(ledgerEvents)
      .values({
        id: eventId(ref),
        instrumentId: i.id,
        type,
        date,
        qty: String(qty),
        price: String(price),
        currency: i.currency,
        fxRateInr: i.currency === "USD" ? "45" : "1",
        source: "opening",
        sourceRef: ref,
        approximate: false,
        ...over,
      })
      .returning();
    return row;
  };
  const dividendsOf = (id: string) =>
    db.select().from(ledgerEvents).where(and(eq(ledgerEvents.instrumentId, id), eq(ledgerEvents.type, "dividend")));
  const IN_NOW = new Date("2003-06-10T11:00:00Z"); // 16:30 IST Tue 2003-06-10
  const US_NOW = new Date("2003-06-10T21:30:00Z"); // 17:30 EDT Tue 2003-06-10
  const WEEK: BarSpec[] = [
    ["2003-06-04", 400],
    ["2003-06-05", 395],
    ["2003-06-06", 398],
    ["2003-06-09", 401],
    ["2003-06-10", 405],
  ];

  beforeEach(() => {
    retry.baseMs = 0;
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    // Cascades: ledger events (→ supersessions), review items, targets, prices_daily, dividends.
    await db.delete(instruments).where(like(instruments.brokerSymbol, `${prefix}%`));
    await db.delete(fxDaily).where(between(fxDaily.date, "2003-05-01", "2003-07-31"));
    await pool.end();
  });

  it("India dividend on a held symbol → net event (TDS default 10%), gross kept; re-run adds nothing", async () => {
    const a = await mk("DIVIN", "IN", { bars: WEEK, divs: [["2003-06-05", 5]] });
    await ev(a, "opening", "2003-05-02", 100, 380);

    const r = await runEod("IN", { now: IN_NOW, only: [a.id] });
    expect(r.status).toBeUndefined();
    expect(r.counts).toMatchObject({ instruments: 1, bars: 5, dividendEvents: 1 });
    const [d] = await dividendsOf(a.id);
    expect(d).toMatchObject({
      sourceRef: `div:${a.id}:2003-06-05`,
      date: "2003-06-05",
      exDate: "2003-06-05",
      qty: "100",
      price: "4.5", // 5 gross − 10% TDS
      grossAmount: "500",
      withholdingRate: "0.1",
      fxRateInr: "1",
      currency: "INR",
    });

    const again = await runEod("IN", { now: IN_NOW, only: [a.id] });
    expect(again.counts.dividendEvents).toBe(0);
    expect(await dividendsOf(a.id)).toHaveLength(1);
  });

  it("US dividend → net of 25% withholding at the ex-date USD/INR (no pay date)", async () => {
    const u = await mk("DIVUS", "US", { bars: WEEK.map(([d]) => [d, 50] as BarSpec), divs: [["2003-06-06", 1]] });
    await ev(u, "opening", "2003-05-02", 10, 40);

    const r = await runEod("US", { now: US_NOW, only: [u.id] });
    expect(r.counts.dividendEvents).toBe(1);
    const [d] = await dividendsOf(u.id);
    expect(d).toMatchObject({ qty: "10", price: "0.75", grossAmount: "10", withholdingRate: "0.25", currency: "USD" });
    expect(Number(d.fxRateInr)).toBe(46.5);
  });

  it("a symbol bought after the ex-date gets no dividend event", async () => {
    const late = await mk("LATE", "IN", { bars: WEEK, divs: [["2003-06-05", 5]] });
    await ev(late, "buy", "2003-06-09", 50, 401, { source: "csv" });

    const r = await runEod("IN", { now: IN_NOW, only: [late.id] });
    expect(r.counts.dividendEvents).toBe(0);
    expect(await dividendsOf(late.id)).toHaveLength(0);
  });

  it("evaluates a pending target to hit using the bar written in the same run", async () => {
    const t = await mk("TGT", "IN", { bars: [["2003-06-09", 101, 105, 99], ["2003-06-10", 108, 112, 104]] });
    const [target] = await db
      .insert(targets)
      .values({ instrumentId: t.id, kind: "target", price: "110", setBy: "owner@example.com", priceAtSet: "100", setAt: new Date("2003-06-02T05:00:00Z") })
      .returning();

    const r = await runEod("IN", { now: IN_NOW, only: [t.id] });
    expect(r.counts.targetsResolved).toBeGreaterThanOrEqual(1);
    const [after] = await db.select().from(targets).where(eq(targets.id, target.id));
    expect(after).toMatchObject({ status: "hit", resolvedAt: "2003-06-10" });
  });

  it("an approximate inferred sell is re-priced at the official close by supersession; its review item resolves", async () => {
    const s = await mk("SELL", "IN", { bars: [["2003-06-09", 97.5], ["2003-06-10", 99]] });
    await ev(s, "opening", "2003-06-02", 10, 90);
    const ref = `inferred:${s.id}:r1:r2`;
    const sell = await ev(s, "sell", "2003-06-09", 4, 95, { source: "inferred", sourceRef: ref, approximate: true });
    await db.insert(ledgerReviewQueue).values({
      instrumentId: s.id,
      kind: "approximate_sell",
      detail: { eventId: sell.id, price: 95, priceSource: "latest" },
    });

    const r = await runEod("IN", { now: IN_NOW, only: [s.id] });
    expect(r.counts.repriced).toBe(1);
    const [fixed] = await db.select().from(ledgerEvents).where(eq(ledgerEvents.sourceRef, `${ref}:close`));
    expect(fixed).toMatchObject({ type: "sell", qty: "4", price: "97.5", source: "inferred", date: "2003-06-09" });
    const links = await db.select().from(ledgerSupersessions).where(eq(ledgerSupersessions.supersededId, sell.id));
    expect(links.map((l) => l.supersedingId)).toEqual([fixed.id]);
    const [item] = await db.select().from(ledgerReviewQueue).where(eq(ledgerReviewQueue.instrumentId, s.id));
    expect(item.resolvedBy).toBe("eod");
    expect(item.resolvedAt).not.toBeNull();
    // The old row is kept (history), and a re-run changes nothing.
    expect((await runEod("IN", { now: IN_NOW, only: [s.id] })).counts.repriced).toBe(0);
    expect(await db.select().from(ledgerEvents).where(eq(ledgerEvents.instrumentId, s.id))).toHaveLength(3);
  });

  it("market holiday (no bar for today) → status holiday; no dividends, targets or re-pricing", async () => {
    // Fri 2003-07-04: Independence Day, NYSE closed; the last bar is Thursday's.
    const h = await mk("HOL", "US", { bars: [["2003-07-02", 20, 20], ["2003-07-03", 21, 21]], divs: [["2003-07-01", 1]] });
    await ev(h, "opening", "2003-05-02", 10, 15);
    const [target] = await db
      .insert(targets)
      .values({ instrumentId: h.id, kind: "target", price: "20.5", setBy: "owner@example.com", priceAtSet: "15", setAt: new Date("2003-06-02T15:00:00Z") })
      .returning();

    const r = await runEod("US", { now: new Date("2003-07-04T21:30:00Z"), only: [h.id] });
    expect(r.status).toBe("holiday");
    expect(r.counts).not.toHaveProperty("dividendEvents");
    expect(await dividendsOf(h.id)).toHaveLength(0);
    const [after] = await db.select().from(targets).where(eq(targets.id, target.id));
    expect(after.status).toBe("pending"); // 21 ≥ 20.5 would be a hit if evaluated
  });
});
