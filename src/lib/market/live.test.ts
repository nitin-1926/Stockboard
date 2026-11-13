import { beforeEach, describe, expect, it, vi } from "vitest";
import { priceLatest, settings } from "@/db/schema";

// Unit: DB, Yahoo, Kite and next/server are mocked. refreshLatest itself is real, so the
// fallback wiring (Kite only for Yahoo misses) is exercised end to end.
const state = vi.hoisted(() => ({
  latest: [] as { id: string; asOf: Date }[],
  claim: true,
  written: [] as { instrumentId: string; source: string; price: string }[],
}));

vi.mock("@/db", () => {
  // Every builder method returns the chain; awaiting it yields `value`.
  const chain = (value: unknown, onValues?: (v: unknown) => void): unknown => {
    const c: unknown = new Proxy(
      {},
      {
        get: (_t, k) =>
          k === "then"
            ? (ok: (v: unknown) => void) => ok(value)
            : (...args: unknown[]) => {
                if (k === "values") onValues?.(args[0]);
                return c;
              },
      },
    );
    return c;
  };
  return {
    db: {
      select: () => chain(state.latest),
      insert: (t: unknown) =>
        t === settings
          ? chain(state.claim ? [{ key: "k" }] : [])
          : chain(undefined, (rows) => t === priceLatest && state.written.push(...(rows as typeof state.written))),
      update: () => chain(undefined),
    },
  };
});

const after = vi.fn();
vi.mock("next/server", () => ({ after: (p: unknown) => after(p) }));

const spark = vi.fn();
const chart = vi.fn();
vi.mock("./yahoo", async (orig) => ({ ...(await orig<typeof import("./yahoo")>()), spark, chart }));

const getConnection = vi.fn();
vi.mock("@/lib/brokers/connections", () => ({ getConnection, setStatus: vi.fn() }));
const getLtp = vi.fn();
vi.mock("@/lib/mcp/kite/tools", () => ({ getLtp }));
const withKite = vi.fn(async (fn: (call: unknown) => unknown) => fn({}));
vi.mock("@/lib/mcp/kite/auth", () => ({ withKite }));

const { ensureFresh, kiteLtp, marketStatus } = await import("./live");
const { YahooError } = await import("./yahoo");

type Inst = Parameters<typeof ensureFresh>[0][number];
const mk = (sym: string, o: Partial<Inst> = {}): Inst => ({
  id: sym,
  market: "IN",
  exchange: "NSE",
  brokerSymbol: sym,
  yahooSymbol: `${sym}.NS`,
  yahooSymbolOverride: null,
  name: sym,
  sector: null,
  industry: null,
  sectorOverridden: false,
  marketCap: null,
  assetClass: "equity",
  currency: "INR",
  isBenchmark: false,
  priceUnavailable: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...o,
});

const OPEN = new Date("2026-11-13T06:00:00Z"); // Fri 11:30 IST; NY 01:00 (closed)
const SAT = new Date("2026-11-14T06:00:00Z");
const quotes = (syms: string[]) => new Map(syms.map((s) => [s, { price: 100, time: OPEN, prevClose: 99 }]));
const sparkSymbols = () => spark.mock.calls.flatMap((c) => c[0] as string[]);

beforeEach(() => {
  state.latest = [];
  state.claim = true;
  state.written = [];
  for (const m of [after, spark, chart, getConnection, getLtp]) m.mockReset();
  withKite.mockClear();
  spark.mockImplementation(async (syms: string[]) => quotes(syms));
  // kiteLtp checks expiry against the real clock, so the token must outlive "now", not OPEN.
  getConnection.mockResolvedValue({ status: "connected", tokenExpiresAt: new Date(Date.now() + 3_600_000) });
});

describe("ensureFresh", () => {
  it("refreshes only open-market instruments whose price is stale or missing", async () => {
    const [fresh, stale, missing, us] = [mk("FRESH"), mk("STALE"), mk("MISSING"), mk("AAPL", { market: "US", currency: "USD", yahooSymbol: "AAPL" })];
    state.latest = [
      { id: "FRESH", asOf: new Date(OPEN.getTime() - 10_000) },
      { id: "STALE", asOf: new Date(OPEN.getTime() - 120_000) },
    ];
    expect(await ensureFresh([fresh, stale, missing, us], { now: OPEN })).toBe("refreshed");
    expect(sparkSymbols().sort()).toEqual(["MISSING.NS", "STALE.NS"]);
    expect(state.written.map((r) => r.instrumentId).sort()).toEqual(["MISSING", "STALE"]);
  });

  it("nothing stale → no Yahoo call", async () => {
    state.latest = [{ id: "A", asOf: OPEN }];
    expect(await ensureFresh([mk("A")], { now: OPEN })).toBe("fresh");
    expect(spark).not.toHaveBeenCalled();
  });

  it("closed markets are skipped without touching the DB or Yahoo; marketStatus agrees", async () => {
    expect(await ensureFresh([mk("A"), mk("SPY", { market: "US" })], { now: SAT })).toBe("closed");
    expect(spark).not.toHaveBeenCalled();
    expect(marketStatus(SAT)).toEqual({ IN: { open: false }, US: { open: false } });
    expect(marketStatus(OPEN)).toEqual({ IN: { open: true }, US: { open: false } });
  });

  it("another instance refreshed this set within the guard window → skip", async () => {
    state.claim = false;
    expect(await ensureFresh([mk("A")], { now: OPEN })).toBe("recent");
    expect(spark).not.toHaveBeenCalled();
  });

  it("budget elapsed → returns pending, hands the rest to after(), and the refresh still lands", async () => {
    let release!: () => void;
    spark.mockImplementation(
      (syms: string[]) => new Promise((r) => (release = () => r(quotes(syms)))),
    );
    const t0 = Date.now();
    expect(await ensureFresh([mk("SLOW")], { now: OPEN, budgetMs: 20 })).toBe("pending");
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(after).toHaveBeenCalledOnce();
    release();
    await after.mock.calls[0][0];
    expect(state.written.map((r) => r.instrumentId)).toEqual(["SLOW"]);
  });

  it("concurrent calls for the same set share one in-flight refresh", async () => {
    const list = [mk("A"), mk("B")];
    const [a, b] = await Promise.all([ensureFresh(list, { now: OPEN }), ensureFresh([...list].reverse(), { now: OPEN })]);
    expect([a, b]).toEqual(["refreshed", "refreshed"]);
    expect(spark).toHaveBeenCalledOnce();
    // Settled: a later call starts a new refresh.
    await ensureFresh(list, { now: OPEN });
    expect(spark).toHaveBeenCalledTimes(2);
  });
});

describe("Kite LTP fallback", () => {
  it("is used only for the instruments Yahoo missed, keyed EXCHANGE:SYMBOL", async () => {
    spark.mockImplementation(async () => quotes(["HIT.NS"]));
    chart.mockRejectedValue(new YahooError("chart MISS.NS: HTTP 500", 500));
    getLtp.mockResolvedValue({ "NSE:MISS": 250 });
    await ensureFresh([mk("HIT"), mk("MISS")], { now: OPEN });
    expect(getLtp).toHaveBeenCalledWith({}, ["NSE:MISS"]);
    expect(state.written).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ instrumentId: "HIT", source: "yahoo" }),
        expect.objectContaining({ instrumentId: "MISS", source: "mcp", price: "250" }),
      ]),
    );
  });

  it("stays out of the path when Yahoo prices everything", async () => {
    await ensureFresh([mk("A")], { now: OPEN });
    expect(getConnection).not.toHaveBeenCalled();
    expect(getLtp).not.toHaveBeenCalled();
  });

  it("Yahoo 401 (datacenter block) → no per-symbol hammering, Kite covers IN", async () => {
    spark.mockRejectedValue(new YahooError("spark: HTTP 401", 401));
    getLtp.mockResolvedValue({ "NSE:A": 10, "NSE:B": 20 });
    await ensureFresh([mk("A"), mk("B")], { now: OPEN });
    expect(chart).not.toHaveBeenCalled();
    expect(state.written.map((r) => [r.instrumentId, r.source])).toEqual([
      ["A", "mcp"],
      ["B", "mcp"],
    ]);
  });

  it("not connected or expired → empty map without calling Kite; US never asked", async () => {
    getConnection.mockResolvedValueOnce({ status: "stale", tokenExpiresAt: null });
    expect((await kiteLtp([mk("A")])).size).toBe(0);
    getConnection.mockResolvedValueOnce({ status: "connected", tokenExpiresAt: new Date(Date.now() - 1) });
    expect((await kiteLtp([mk("A")])).size).toBe(0);
    expect(await kiteLtp([mk("AAPL", { market: "US" })])).toEqual(new Map());
    expect(withKite).not.toHaveBeenCalled();
  });

  it("swallows Kite errors", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    withKite.mockRejectedValueOnce(new Error("session expired"));
    await expect(kiteLtp([mk("A")])).resolves.toEqual(new Map());
    err.mockRestore();
  });
});
