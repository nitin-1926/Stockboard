import { describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth/access";

// buildSymbolView is pure; the DB and auth modules are only imported for the loader.
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/auth/access", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/access")>()), requireActor: vi.fn() }));

const { buildSymbolView, LOT_POLICY } = await import("./symbol");
const { factorAfter } = await import("@/lib/targets/evaluate");
const { DEFAULT_CAP_THRESHOLDS } = await import("@/lib/market/market-cap");
type SymbolInputs = import("./symbol").SymbolInputs;
type TargetRow = import("./targets").TargetRow;

const owner: Actor = { kind: "owner", email: "o@example.com", hideAmounts: false, via: "session" };
const hidden: Actor = { kind: "viewer", hideAmounts: true, via: "share-link" };
const NOW = new Date("2026-11-11T06:00:00Z"); // 11:30 IST

function inputs(o: Partial<SymbolInputs> = {}): SymbolInputs {
  return {
    instrument: {
      id: "inst",
      symbol: "INFY",
      name: "Infosys",
      market: "IN",
      currency: "INR",
      exchange: "NSE",
      sector: "Technology",
      industry: null,
      marketCap: 6e12,
      priceUnavailable: false,
    },
    price: { price: 1000, asOf: new Date("2026-11-11T05:45:00Z"), source: "yahoo" },
    bars: [],
    actions: [],
    trades: [],
    lots: [],
    snapshot: null,
    watch: [],
    activeTargets: [],
    bucketsByEvent: {},
    capThresholds: DEFAULT_CAP_THRESHOLDS,
    range: "1y",
    now: NOW,
    ...o,
  };
}

const lot = (o: { eventId: string; qty: number; costPerShare: number; openDate: string } & Partial<SymbolInputs["lots"][number]>) => ({
  instrumentId: "inst",
  market: "IN" as const,
  currency: "INR" as const,
  fxRateAtOpen: 1,
  closed: [],
  approximate: false,
  bonus: false,
  ...o,
});

describe("buildSymbolView chart", () => {
  // A 2:1 split with ex-date 2026-06-01: raw closes ~2000 before, ~1000 from the ex-date on.
  const split = { actions: [{ exDate: "2026-06-01", ratio: 2 }] };

  it("puts closes, trades, watch adds and target levels on today's basis", () => {
    const v = buildSymbolView(
      inputs({
        ...split,
        bars: [
          { date: "2026-05-29", close: 2010 },
          { date: "2026-06-01", close: 1004 },
          { date: "2026-11-10", close: 990 },
        ],
        trades: [
          { id: "b1", type: "buy", date: "2026-03-02", qty: 10, price: 1900, approximate: false },
          { id: "s1", type: "sell", date: "2026-07-01", qty: 5, price: 1050, approximate: false },
        ],
        watch: [{ id: "w", addedAt: new Date("2026-02-02T05:00:00Z"), priceAtAdd: 1800, archived: false }],
        // As buildTargetsView hands them over: set before the split at a raw 2400 → 1200 today; a later stop at 900 stays.
        activeTargets: [
          { instrumentId: "inst", kind: "target", price: 1200, setPrice: 2400, setOn: "2026-04-01", distancePct: 0.2 },
          { instrumentId: "inst", kind: "target", price: 1300, setPrice: 2600, setOn: "2026-04-01", distancePct: 0.3 },
          { instrumentId: "inst", kind: "stop", price: 900, setPrice: null, setOn: "2026-08-01", distancePct: -0.1 },
        ] as TargetRow[],
      }),
      owner,
    );
    expect(v.chart.points.map((p) => p.close)).toEqual([1005, 1004, 990]);
    expect(v.chart.markers.map((m) => [m.kind, m.date, m.price, m.qty])).toEqual([
      ["watch", "2026-02-02", 900, null],
      ["buy", "2026-03-02", 950, 20],
      ["sell", "2026-07-01", 1050, 5],
    ]);
    expect(v.chart.levels).toEqual([
      { kind: "target", price: 1200 },
      { kind: "stop", price: 900 },
    ]);
    // The targets list keeps buildTargetsView's adjusted level, distance and stored level.
    expect(v.targets[0]).toMatchObject({ price: 1200, setPrice: 2400 });
    expect(v.targets[0].distancePct).toBeCloseTo(0.2);
    expect(v.targets[2]).toMatchObject({ price: 900, setPrice: null, distancePct: -0.1 });
    expect(v.chart.adjustedFor).toEqual([{ exDate: "2026-06-01", ratio: 2 }]);
    // Day change against the adjusted previous close (990), not a raw one.
    expect(v.quote?.dayChangePct).toBeCloseTo(1000 / 990 - 1);
    expect(v.chart.low).toEqual({ date: "2026-11-10", close: 990 });
  });

  it("the ex-date's own bar and trades are already post-split", () => {
    expect(factorAfter("2026-06-01", split.actions)).toBe(1);
    expect(factorAfter("2026-05-31", split.actions)).toBe(2);
  });

  it("range limits points and markers; the previous close can come from before the range", () => {
    const v = buildSymbolView(
      inputs({
        range: "1m",
        bars: [
          { date: "2026-09-01", close: 800 },
          { date: "2026-10-20", close: 950 },
          { date: "2026-11-10", close: 980 },
        ],
        trades: [{ id: "b", type: "buy", date: "2026-09-01", qty: 1, price: 800, approximate: false }],
      }),
      owner,
    );
    expect(v.chart.points.map((p) => p.date)).toEqual(["2026-10-20", "2026-11-10"]);
    expect(v.chart.markers).toEqual([]);
    expect(v.chart.changePct).toBeCloseTo(1000 / 950 - 1);
  });
});

describe("buildSymbolView lots", () => {
  const withLots = inputs({
    lots: [
      lot({ eventId: "e2", qty: 10, costPerShare: 1100, openDate: "2026-03-15" }),
      lot({ eventId: "e1", qty: 30, costPerShare: 800, openDate: "2025-02-10", approximate: true }),
    ],
    snapshot: { qty: 40, avgPrice: 862.5, takenAt: NOW },
    bucketsByEvent: { e1: [{ id: "b", name: "Core", color: "chart-1" }] },
  });

  it("LTCG dates (India 12 months, more-than rule) and the broker average next to FIFO", () => {
    const v = buildSymbolView(withLots, owner);
    const [first, second] = v.position!.lots;
    expect(first).toMatchObject({ eventId: "e1", openDate: "2025-02-10", ltcgDate: "2026-02-11", longTerm: true, approximate: true });
    expect(second).toMatchObject({ ltcgDate: "2027-03-16", longTerm: false, daysToLtcg: 125 });
    expect(first.sharePct).toBeCloseTo(0.75);
    expect(first.returnPct).toBeCloseTo(0.25);
    expect(v.position!.avgCost).toBeCloseTo(875); // FIFO: (30×800 + 10×1100) / 40
    expect(v.position!.brokerAvg).toBe(862.5);
    expect(v.position!.buckets.map((b) => b.name)).toEqual(["Core"]);
  });

  it("US lots use 24 months", () => {
    const v = buildSymbolView(
      inputs({
        instrument: { ...inputs().instrument, market: "US", currency: "USD" },
        lots: [lot({ eventId: "u", qty: 1, costPerShare: 100, openDate: "2025-02-10", market: "US", currency: "USD" })],
      }),
      owner,
    );
    expect(v.position!.lots[0]).toMatchObject({ ltcgDate: "2027-02-11", longTerm: false });
  });

  it("hide-amounts: lots keep dates and % but no qty or cost; markers lose qty", () => {
    const v = buildSymbolView(
      { ...withLots, trades: [{ id: "b", type: "buy", date: "2026-03-15", qty: 10, price: 1100, approximate: false }] },
      hidden,
    );
    for (const l of v.position!.lots) {
      for (const k of LOT_POLICY) expect(k in l).toBe(false);
      expect(l.ltcgDate).toBeTruthy();
      expect(typeof l.sharePct).toBe("number");
    }
    expect("qty" in v.position!).toBe(false);
    expect("qty" in v.chart.markers[0]).toBe(false);
    const json = JSON.stringify(v);
    expect(json).not.toMatch(/"(qty|costPerShare|invested)"/);
    expect(v.chart.markers[0].price).toBe(1100);
  });

  it("no lots but a broker snapshot → one approximate lot at the broker average", () => {
    const v = buildSymbolView(inputs({ snapshot: { qty: 5, avgPrice: 700, takenAt: NOW } }), owner);
    expect(v.position!.lots).toHaveLength(1);
    expect(v.position!.lots[0]).toMatchObject({ approximate: true, costPerShare: 700, openDate: "2026-11-11" });
  });

  it("not held → no position", () => {
    expect(buildSymbolView(inputs(), owner).position).toBeNull();
  });
});
