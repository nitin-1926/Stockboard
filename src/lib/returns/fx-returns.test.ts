import { describe, expect, it } from "vitest";
import { fxReturns } from "./fx-returns";
import { positionPnl } from "./pnl";

describe("fxReturns", () => {
  it("10 AAPL @ $150, fx 83 → $150, fx 94: USD 0%, INR ≈13.25%, FX ≈13.25%", () => {
    const p = positionPnl({
      lots: [
        {
          instrumentId: "AAPL",
          market: "US",
          currency: "USD",
          qty: 10,
          costPerShare: 150,
          openDate: "2025-01-01",
          fxRateAtOpen: 83,
          closed: [],
        },
      ],
      price: 150,
      fxNow: 94,
      asOf: "2026-01-01",
    });
    const r = fxReturns(p);
    expect(r.nativeReturn).toBeCloseTo(0, 12);
    expect(r.inrReturn).toBeCloseTo(94 / 83 - 1, 12); // 0.132530…
    expect(r.inrReturn).toBeCloseTo(0.1325, 4);
    expect(r.fxContribution).toBeCloseTo(0.1325, 4);
  });

  it("price and FX both move: contribution = INR − native (includes cross term)", () => {
    const r = fxReturns({ costNative: 1500, costInr: 124500, valueNative: 1650, valueInr: 1650 * 94 });
    expect(r.nativeReturn).toBeCloseTo(0.1, 12);
    expect(r.inrReturn).toBeCloseTo((1.1 * 94) / 83 - 1, 12);
    expect(r.fxContribution).toBeCloseTo(r.inrReturn! - 0.1, 12);
  });

  it("INR holding: no FX contribution", () => {
    const r = fxReturns({ costNative: 1000, costInr: 1000, valueNative: 1200, valueInr: 1200 });
    expect(r.fxContribution).toBeCloseTo(0, 12);
  });

  it("zero cost (fully closed or bonus-only) → nulls, not Infinity", () => {
    expect(fxReturns({ costNative: 0, costInr: 0, valueNative: 100, valueInr: 100 })).toEqual({
      nativeReturn: null,
      inrReturn: null,
      fxContribution: null,
    });
  });
});
