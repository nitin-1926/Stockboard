import { describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth/access";

// buildHoldingsView is pure; the DB and auth modules are only imported for the loader.
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/auth/access", () => ({ requireActor: vi.fn(), getActor: vi.fn() }));

const { buildHoldingsView, HOLDING_POLICY, TOTALS_POLICY } = await import("./holdings");
type HoldingInput = import("./holdings").HoldingInput;
const { buildConnectionsView } = await import("./connections");

const owner: Actor = { kind: "owner", email: "o@example.com", hideAmounts: false, via: "session" };
const hidden: Actor = { kind: "viewer", hideAmounts: true, via: "share-link" };
const NOW = new Date("2026-11-11T06:00:00Z"); // 11:30 IST, 01:00 New York
const PRICED_AT = new Date("2026-11-11T05:45:00Z");

const lot = (o: Partial<HoldingInput["lots"][number]> & { qty: number; costPerShare: number; openDate: string }) => ({
  instrumentId: "x",
  market: "IN" as const,
  currency: "INR" as const,
  fxRateAtOpen: 1,
  closed: [],
  approximate: false,
  ...o,
});

function holding(o: Partial<HoldingInput> & Pick<HoldingInput, "symbol">): HoldingInput {
  return {
    instrumentId: o.symbol,
    name: `${o.symbol} Ltd`,
    market: "IN",
    currency: "INR",
    exchange: "NSE",
    priceUnavailable: false,
    snapshot: { qty: 10, t1Qty: 0, avgPrice: 0, ltp: null, takenAt: PRICED_AT },
    lots: [],
    price: null,
    closes: [],
    ...o,
  };
}

const INFY = holding({
  symbol: "INFY",
  lots: [lot({ qty: 10, costPerShare: 1500, openDate: "2025-06-01" })],
  price: { price: 1600, asOf: PRICED_AT, source: "yahoo" },
  closes: [
    { date: "2026-11-10", close: 1580 },
    { date: "2026-11-09", close: 1500 },
  ],
});
const TCS = holding({
  symbol: "TCS",
  snapshot: { qty: 10, t1Qty: 2, avgPrice: 3000, ltp: 3290, takenAt: PRICED_AT },
  lots: [
    lot({ qty: 5, costPerShare: 3000, openDate: "2026-03-01", approximate: true }),
    lot({ qty: 5, costPerShare: 3000, openDate: "2026-04-01" }),
  ],
  price: { price: 3300, asOf: PRICED_AT, source: "yahoo" },
  closes: [{ date: "2026-11-10", close: 3300 }],
});
// U12's FX example: 10 AAPL @ $150 bought at 83, now $150 at 94 → USD 0%, INR/FX ≈13.25%.
const AAPL = holding({
  symbol: "AAPL",
  market: "US",
  currency: "USD",
  exchange: "NASDAQ",
  lots: [lot({ market: "US", currency: "USD", qty: 10, costPerShare: 150, openDate: "2025-01-01", fxRateAtOpen: 83 })],
  price: { price: 150, asOf: new Date("2026-11-10T21:00:00Z"), source: "yahoo" },
  closes: [{ date: "2026-11-09", close: 148 }],
});
const NOPRICE = holding({
  symbol: "DELISTED",
  priceUnavailable: true,
  lots: [lot({ qty: 4, costPerShare: 100, openDate: "2026-01-05" })],
});

const fx = { usdInr: 94, date: "2026-11-11" };
const view = (actor = owner, holdings = [INFY, TCS, AAPL, NOPRICE]) =>
  buildHoldingsView({ holdings, fx, now: NOW }, actor);

describe("buildHoldingsView", () => {
  it("combined INR totals equal the sum of INR-converted priced rows", () => {
    const v = view();
    const priced = v.rows.filter((r) => !r.unpriced);
    expect(v.totals.all.valueInr).toBeCloseTo(16_000 + 33_000 + 10 * 150 * 94, 6);
    expect(v.totals.all.valueInr).toBeCloseTo(
      priced.reduce((s, r) => s + r.valueInr!, 0),
      6,
    );
    expect(v.totals.all.investedInr).toBeCloseTo(15_000 + 30_000 + 10 * 150 * 83, 6);
    expect(v.totals.IN.valueInr! + v.totals.US.valueInr!).toBeCloseTo(v.totals.all.valueInr!, 6);
    expect(v.totals.all.count).toBe(4);
    expect(v.totals.all.pricedCount).toBe(3);
  });

  it("US section and row: USD 0%, INR and FX contribution ≈13.25% (U12 example)", () => {
    const v = view();
    const aapl = v.rows.find((r) => r.symbol === "AAPL")!;
    expect(aapl.returnPct).toBeCloseTo(0, 12);
    expect(aapl.returnInrPct).toBeCloseTo(94 / 83 - 1, 12);
    expect(aapl.fxContributionPct).toBeCloseTo(0.1325, 4);
    expect(v.totals.US.returnUsdPct).toBeCloseTo(0, 12);
    expect(v.totals.US.fxContributionPct).toBeCloseTo(0.1325, 4);
    expect(v.rows.find((r) => r.symbol === "INFY")!.fxContributionPct).toBeNull();
  });

  it("day change uses the previous close before the price's market date", () => {
    const v = view();
    const infy = v.rows.find((r) => r.symbol === "INFY")!;
    expect(infy.dayChangePct).toBeCloseTo(1600 / 1580 - 1, 12);
    expect(infy.dayChangeInr).toBeCloseTo(200, 9);
    // AAPL priced 2026-11-10 New York time: prev is the 2026-11-09 close; INR at today's FX.
    expect(v.rows.find((r) => r.symbol === "AAPL")!.dayChangeInr).toBeCloseTo(10 * 2 * 94, 9);
    expect(v.totals.all.dayChangeInr).toBeCloseTo(200 + 0 + 1880, 9);
  });

  it("day change prefers price_latest.prev_close; no daily closes needed; top-level freshest as-of", () => {
    const stored = holding({
      symbol: "INFY",
      lots: [lot({ qty: 10, costPerShare: 1500, openDate: "2025-06-01" })],
      price: { price: 1600, asOf: PRICED_AT, source: "yahoo", prevClose: 1550 },
      closes: [{ date: "2026-11-10", close: 1580 }],
    });
    const bare = holding({ ...stored, symbol: "BARE", closes: [] });
    const noPrev = holding({ ...stored, symbol: "NOPREV", price: { ...stored.price!, prevClose: null } });
    const v = view(owner, [stored, bare, noPrev, AAPL]);
    const row = (s: string) => v.rows.find((r) => r.symbol === s)!;
    expect(row("INFY").dayChangePct).toBeCloseTo(1600 / 1550 - 1, 12);
    expect(row("INFY").dayChangeInr).toBeCloseTo(500, 9);
    expect(row("BARE").dayChangeInr).toBeCloseTo(500, 9);
    expect(row("NOPREV").dayChangePct).toBeCloseTo(1600 / 1580 - 1, 12); // falls back to closes
    expect(row("INFY").priceAsOf).toBe(PRICED_AT.toISOString());
    expect(v.priceAsOf).toBe(PRICED_AT.toISOString());
  });

  it("carries approximate, T+1 and unpriced flags; unpriced rows are excluded from totals", () => {
    const v = view();
    const tcs = v.rows.find((r) => r.symbol === "TCS")!;
    expect(tcs.approximate).toBe(true);
    expect(tcs.t1).toBe(true);
    expect(v.rows.find((r) => r.symbol === "INFY")!.approximate).toBe(false);
    const dead = v.rows.find((r) => r.symbol === "DELISTED")!;
    expect(dead.unpriced).toBe(true);
    expect(dead.valueInr).toBeNull();
    expect(dead.weightPct).toBeNull();
    expect(v.flags).toEqual({ approximate: 1, unpriced: 1, t1: 1 });
  });

  it("no ledger lots yet → broker avg as an approximate lot", () => {
    const fresh = holding({
      symbol: "NEW",
      snapshot: { qty: 3, t1Qty: 0, avgPrice: 200, ltp: 210, takenAt: PRICED_AT },
    });
    const r = view(owner, [fresh]).rows[0];
    expect(r.approximate).toBe(true);
    expect(r.investedInr).toBeCloseTo(600, 9);
    expect(r.priceSource).toBe("broker");
    expect(r.valueInr).toBeCloseTo(630, 9);
  });

  it("LTCG: days to the next lot crossing, or long-term when every lot has", () => {
    const v = view();
    const tcs = v.rows.find((r) => r.symbol === "TCS")!;
    expect(tcs.ltcg).toEqual({ allLongTerm: false, nextEligible: "2027-03-02", daysToNext: 111 });
    expect(tcs.heldSince).toBe("2026-03-01");
    expect(tcs.heldDays).toBe(255);
    expect(v.rows.find((r) => r.symbol === "INFY")!.ltcg.allLongTerm).toBe(true);
    // US needs 24 months: bought 2025-01-01 → eligible 2027-01-02.
    expect(v.rows.find((r) => r.symbol === "AAPL")!.ltcg.nextEligible).toBe("2027-01-02");
  });

  it("allocation is sorted by weight, sums to 100%, and folds the tail into Other", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      holding({
        symbol: `S${i}`,
        lots: [lot({ qty: 1, costPerShare: 100, openDate: "2026-01-01" })],
        price: { price: 100 + i, asOf: PRICED_AT, source: "yahoo" },
      }),
    );
    const v = view(owner, many);
    expect(v.allocation).toHaveLength(7);
    expect(v.allocation[0].label).toBe("S8");
    expect(v.allocation.at(-1)!.label).toBe("Other");
    expect(v.allocation.reduce((s, a) => s + a.weightPct, 0)).toBeCloseTo(1, 12);
  });

  it("bucket tabs: each live bucket counts the holdings with an open lot in it", () => {
    const v = buildHoldingsView(
      {
        holdings: [{ ...INFY, bucketIds: ["b1", "b2"] }, { ...TCS, bucketIds: ["b1"] }, AAPL],
        buckets: [
          { id: "b1", name: "Manager picks", color: "chart-1" },
          { id: "b2", name: "Self", color: "chart-2" },
          { id: "b3", name: "Empty", color: "chart-3" },
        ],
        fx,
        now: NOW,
      },
      owner,
    );
    expect(v.buckets.map((b) => [b.name, b.count])).toEqual([
      ["Manager picks", 2],
      ["Self", 1],
      ["Empty", 0],
    ]);
    expect(v.rows.find((r) => r.symbol === "AAPL")!.bucketIds).toEqual([]);
  });

  it("no holdings → an empty-state DTO, not an error", () => {
    const v = view(owner, []);
    expect(v.empty).toBe(true);
    expect(v.rows).toEqual([]);
    expect(v.allocation).toEqual([]);
    expect(v.totals.all).toMatchObject({ count: 0, valueInr: 0, returnPct: null, dayChangePct: null });
  });

  it("hide-amounts actor: amount fields absent from the payload; prices and percentages stay", () => {
    const v = view(hidden);
    const json = JSON.stringify(v);
    for (const k of [...HOLDING_POLICY, ...TOTALS_POLICY]) expect(json).not.toContain(`"${k}"`);
    expect(v.amountsHidden).toBe(true);
    const infy = v.rows.find((r) => r.symbol === "INFY")!;
    expect(infy).toMatchObject({ price: 1600, avgCost: 1500 });
    expect(infy.returnPct).toBeCloseTo(1600 / 1500 - 1, 12);
    expect(infy.weightPct).toBeGreaterThan(0);
    expect(v.totals.all.returnPct).not.toBeNull();
    expect(v.totals.US.fxContributionPct).toBeCloseTo(0.1325, 4);
    // Same row order as the owner's: ranking by weight leaks no amount.
    expect(v.rows.map((r) => r.symbol)).toEqual(view().rows.map((r) => r.symbol));
  });
});

describe("buildConnectionsView", () => {
  const conn = (o: Partial<Parameters<typeof buildConnectionsView>[0][number]["view"]>) => ({
    view: {
      broker: "kite" as const,
      status: "connected" as const,
      lastSyncAt: new Date("2026-11-10T10:20:00Z"),
      lastErrorStep: null,
      credentialsSet: true,
      credentialsUpdatedAt: null,
      tokenExpiresAt: null,
      ...o,
    },
    lastSuccessAt: new Date("2026-11-10T10:20:00Z"),
  });

  it("owner sees the failing step; others only learn the data date", () => {
    const failing = [conn({ status: "login_failed", lastErrorStep: "totp" })];
    expect(buildConnectionsView(failing, owner, NOW).banners).toEqual([
      expect.objectContaining({ problem: "login_failed", step: "totp", owner: true }),
    ]);
    const forViewer = buildConnectionsView(failing, hidden, NOW).banners;
    expect(forViewer).toEqual([{ broker: "kite", label: "Kite", asOf: "2026-11-10T10:20:00.000Z", owner: false }]);
  });

  it("never-connected broker: no banner and anyConnected false; a late connected sync is flagged", () => {
    const never = buildConnectionsView([conn({ status: "disconnected", lastSyncAt: null })], owner, NOW);
    expect(never).toEqual({ banners: [], anyConnected: false });
    // Last success Tue 10:20 UTC; at Wed 13:00 UTC the Wed 10:15 slot (+150 min grace) has no success.
    const late = buildConnectionsView([conn({})], owner, new Date("2026-11-11T13:00:00Z"));
    expect(late.banners[0]).toMatchObject({ problem: "sync_late" });
  });
});
