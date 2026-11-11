import { describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth/access";

// buildAllocationView is pure; the DB and auth modules are only imported for the loader.
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/auth/access", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/access")>()), requireActor: vi.fn() }));

const { buildAllocationView, UNCLASSIFIED } = await import("./allocation");
const { DEFAULT_CAP_THRESHOLDS } = await import("@/lib/market/market-cap");
type AllocationHolding = import("./allocation").AllocationHolding;

const owner: Actor = { kind: "owner", email: "o@example.com", hideAmounts: false, via: "session" };
const hidden: Actor = { kind: "viewer", hideAmounts: true, via: "share-link" };
const limits = { stockPct: 20, sectorPct: 35, capThresholds: DEFAULT_CAP_THRESHOLDS };

const h = (symbol: string, weightPct: number | null, o: Partial<AllocationHolding> = {}): AllocationHolding => ({
  instrumentId: `id-${symbol}`,
  symbol,
  name: `${symbol} Ltd`,
  market: "IN",
  weightPct,
  sector: "Technology",
  marketCap: 1e12,
  ...o,
});

describe("buildAllocationView", () => {
  it("40% in one stock with a 20% limit → a warning naming the stock and its weight", () => {
    const v = buildAllocationView(
      {
        limits,
        holdings: [
          h("INFY", 0.4, { sector: "Technology" }),
          h("HDFCBANK", 0.3, { sector: "Financial Services" }),
          h("ITC", 0.15, { sector: "Consumer Defensive" }),
          h("TCS", 0.15, { sector: "Industrials" }),
        ],
      },
      owner,
    );
    const stock = v.warnings.filter((w) => w.kind === "stock");
    expect(stock).toHaveLength(2); // HDFCBANK at 30% is over 20% too
    expect(stock[0]).toMatchObject({ label: "INFY", key: "id-INFY", weightPct: 0.4, limitPct: 0.2 });
    // Technology is 40% > 35% as a sector.
    expect(v.warnings.find((w) => w.kind === "sector")).toMatchObject({ label: "Technology", weightPct: 0.4, limitPct: 0.35 });
  });

  it("a sector over its limit warns even when no single stock does", () => {
    const v = buildAllocationView(
      {
        limits,
        holdings: [
          h("A", 0.19, { sector: "Financial Services" }),
          h("B", 0.19, { sector: "Financial Services" }),
          h("C", 0.18, { sector: "Energy" }),
          h("D", 0.16, { sector: "Utilities" }),
          h("E", 0.14, { sector: "Healthcare" }),
          h("F", 0.14, { sector: "Industrials" }),
        ],
      },
      owner,
    );
    expect(v.warnings).toHaveLength(1);
    expect(v.warnings[0]).toMatchObject({ kind: "sector", key: "Financial Services", label: "Financial Services", limitPct: 0.35 });
    expect(v.warnings[0].weightPct).toBeCloseTo(0.38);
  });

  it("missing sector → Unclassified (not dropped), listed for the owner, and never a sector warning", () => {
    const v = buildAllocationView(
      { limits, holdings: [h("NIFTYETF", 0.5, { sector: null }), h("AAPL", 0.3, { sector: "  " }), h("INFY", 0.2)] },
      owner,
    );
    const total = v.bySector.reduce((s, g) => s + g.weightPct, 0);
    expect(total).toBeCloseTo(1);
    expect(v.bySector.at(-1)).toMatchObject({ key: UNCLASSIFIED, label: UNCLASSIFIED, count: 2, symbols: ["NIFTYETF", "AAPL"] });
    expect(v.bySector.at(-1)!.weightPct).toBeCloseTo(0.8);
    expect(v.unclassified.map((u) => u.symbol)).toEqual(["NIFTYETF", "AAPL"]);
    expect(v.warnings.some((w) => w.kind === "sector")).toBe(false);
    expect(v.canManage).toBe(true);
  });

  it("groups by market and cap bucket; unpriced holdings are counted, not weighted", () => {
    const v = buildAllocationView(
      {
        limits,
        holdings: [
          h("INFY", 0.5, { marketCap: 6e12 }), // ₹6 lakh cr → large
          h("SMALLCO", 0.2, { marketCap: 1_000e7 }), // ₹1,000 cr → small
          h("AAPL", 0.3, { market: "US", marketCap: 3e12 }),
          h("NOPRICE", null),
        ],
      },
      owner,
    );
    expect(v.byMarket.map((g) => [g.label, g.weightPct])).toEqual([
      ["India", 0.7],
      ["US", 0.3],
    ]);
    expect(v.byCap.map((g) => [g.key, g.weightPct])).toEqual([
      ["large", 0.8],
      ["small", 0.2],
    ]);
    expect(v.unpriced).toBe(1);
    expect(v.byStock.map((g) => g.label)).toEqual(["INFY", "AAPL", "SMALLCO"]);
  });

  it("hide-amounts viewer: same percentages, no amount keys, no owner controls", () => {
    const inputs = { limits, holdings: [h("INFY", 0.6), h("TCS", 0.4, { sector: null })] };
    const mine = buildAllocationView(inputs, owner);
    const theirs = buildAllocationView(inputs, hidden);
    expect(theirs.amountsHidden).toBe(true);
    expect(theirs.canManage).toBe(false);
    expect({ ...theirs, amountsHidden: false, canManage: true }).toEqual(mine);
    const json = JSON.stringify(theirs);
    for (const k of ["qty", "value", "invested", "pnl", "cost", "Inr", "Native", "marketCap"]) expect(json).not.toContain(k);
    expect(theirs.byStock[0].weightPct).toBe(0.6);
  });

  it("empty inputs → empty view, no warnings", () => {
    const v = buildAllocationView({ limits, holdings: [] }, owner);
    expect(v.empty).toBe(true);
    expect(v.warnings).toEqual([]);
  });
});
