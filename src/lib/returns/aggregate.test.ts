import { describe, expect, it } from "vitest";
import { aggregate, PAPER_NOTIONAL_INR } from "./aggregate";
import type { Lot } from "./types";

const lot = (instrumentId: string, qty: number, cost: number): Lot => ({
  instrumentId,
  market: "IN",
  currency: "INR",
  qty,
  costPerShare: cost,
  openDate: "2025-01-01",
  fxRateAtOpen: 1,
  closed: [],
});

const positions = [
  { lots: [lot("X", 10, 100)], price: 120, fxNow: 1 }, // 1000 → 1200
  { lots: [lot("Y", 5, 200)], price: 180, fxNow: 1 }, // 1000 → 900
];
const paper = [{ priceAtAdd: 50, addedAt: "2025-01-01", price: 60 }]; // +20%, on the fixed notional

describe("aggregate", () => {
  it("bucket with 2 real lots + 1 paper item → separate real/paper, combined %", () => {
    const r = aggregate({ positions, paper, asOf: "2026-01-01" });

    expect(r.real.costInr).toBeCloseTo(2000); // paper never in money totals
    expect(r.real.valueInr).toBeCloseTo(2100);
    expect(r.real.unrealizedInr).toBeCloseTo(100);
    expect(r.real.totalReturnInr).toBeCloseTo(100);
    expect(r.real.returns.absolute).toBeCloseTo(0.05, 9);
    expect(r.real.returns.xirr).toBeCloseTo(0.05, 9);

    expect(r.paper.count).toBe(1);
    expect(r.paper.returns.absolute).toBeCloseTo(0.2, 9);

    // Paper joins only here, as ₹10,000 notional → ₹12,000.
    const n = PAPER_NOTIONAL_INR;
    expect(r.combined.absolute).toBeCloseTo((2100 + 1.2 * n) / (2000 + n) - 1, 9);
    expect(r.real.flows.every((f) => f.amountInr !== -n)).toBe(true);
  });

  it("paper items are equal-weighted: a ₹10 stock counts as much as a ₹10,000 one", () => {
    const r = aggregate({
      positions: [],
      paper: [
        { priceAtAdd: 10, addedAt: "2025-01-01", price: 13 }, // +30%
        { priceAtAdd: 10_000, addedAt: "2025-01-01", price: 9_000 }, // -10%
      ],
      asOf: "2025-06-01",
    });
    expect(r.paper.returns.absolute).toBeCloseTo(0.1, 9); // mean of +30% and -10%, not price-weighted (≈ -9.97%)
    expect(r.paper.returns.useAbsolute).toBe(true);
    expect(r.real.costInr).toBe(0);
  });

  it("US paper item converts at FX on add and now", () => {
    const r = aggregate({
      positions: [],
      paper: [{ priceAtAdd: 150, addedAt: "2025-01-01", price: 150, fxAtAdd: 83, fxNow: 94 }],
      asOf: "2026-01-01",
    });
    expect(r.paper.returns.absolute).toBeCloseTo(94 / 83 - 1, 9);
    expect(r.real.costInr).toBe(0);
    expect(r.real.returns.absolute).toBeNull();
  });

  it("real totals include realized P&L and net dividends", () => {
    const sold: Lot = {
      ...lot("Z", 10, 100),
      closed: [{ qty: 10, date: "2025-06-01", pricePerShare: 110, fxRate: 1 }],
    };
    const r = aggregate({
      positions: [
        {
          lots: [sold],
          price: 0,
          fxNow: 1,
          dividends: [{ exDate: "2025-03-01", perShareGross: 5, currency: "INR", fxRate: 1 }],
          withholdingRate: 0.1,
        },
      ],
      paper: [],
      asOf: "2026-01-01",
    });
    expect(r.real.realizedInr).toBeCloseTo(100);
    expect(r.real.dividendsNetInr).toBeCloseTo(45);
    expect(r.real.dividendsGrossInr).toBeCloseTo(50);
    expect(r.real.totalReturnInr).toBeCloseTo(145);
    expect(r.real.costInr).toBe(0); // nothing open
    expect(r.real.returns.absolute).toBeCloseTo(0.145, 9);
  });

  it("empty bucket → zero totals, null returns", () => {
    const r = aggregate({ positions: [], paper: [], asOf: "2026-01-01" });
    expect(r.real.valueInr).toBe(0);
    expect(r.paper.returns.absolute).toBeNull();
    expect(r.combined.absolute).toBeNull();
  });
});
