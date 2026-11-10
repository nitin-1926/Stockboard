import { describe, expect, it } from "vitest";
import { benchmark } from "./benchmark";

const invest = [{ date: "2025-01-01", amount: -10000 }];

describe("benchmark (Long-Nickels PME)", () => {
  it("single flow, index +12% over 1y → benchmark ≈12%, alpha = portfolio − 12%", () => {
    const r = benchmark(invest, { date: "2026-01-01", amount: 11500 }, {
      closes: { "2025-01-01": 100, "2026-01-01": 112 },
    });
    expect(r.method).toBe("pme");
    expect(r.benchmarkTerminal).toBeCloseTo(11200);
    expect(r.benchmarkXirr).toBeCloseTo(0.12, 9);
    expect(r.portfolioXirr).toBeCloseTo(0.15, 9);
    expect(r.alpha).toBeCloseTo(0.03, 9);
  });

  it("flow on a market holiday uses the previous trading day's close", () => {
    // 2025-01-04 (Sat) and 2026-01-04 (Sun) have no close.
    const r = benchmark(
      [{ date: "2025-01-04", amount: -10000 }],
      { date: "2026-01-04", amount: 11000 },
      { closes: { "2025-01-03": 100, "2025-01-06": 105, "2026-01-02": 112, "2026-01-05": 120 } },
    );
    expect(r.benchmarkTerminal).toBeCloseTo(11200);
    expect(r.benchmarkXirr).toBeCloseTo(0.12, 9);
  });

  it("total return from raw close + reinvested dividends", () => {
    const r = benchmark(invest, { date: "2026-01-01", amount: 10000 }, {
      closes: { "2025-01-01": 100, "2025-07-01": 100, "2026-01-01": 100 },
      dividends: [{ exDate: "2025-07-01", perShareGross: 2 }],
    });
    expect(r.benchmarkTerminal).toBeCloseTo(10200);
    expect(r.benchmarkXirr).toBeCloseTo(0.02, 9);
  });

  it("index dividends are reinvested net of the same withholding as the portfolio's", () => {
    const r = benchmark(invest, { date: "2026-01-01", amount: 10000 }, {
      closes: { "2025-01-01": 100, "2025-07-01": 100, "2026-01-01": 100 },
      dividends: [{ exDate: "2025-07-01", perShareGross: 2 }],
      withholdingRate: 0.25,
    });
    expect(r.benchmarkTerminal).toBeCloseTo(10150); // 2 gross → 1.5 net per unit
  });

  it("raw close drop on a split is neutralized by the split ratio", () => {
    const r = benchmark(invest, { date: "2026-01-01", amount: 10000 }, {
      closes: { "2025-01-01": 100, "2025-07-01": 50, "2026-01-01": 56 },
      splits: [{ exDate: "2025-07-01", ratio: 2 }],
    });
    expect(r.benchmarkTerminal).toBeCloseTo(11200);
  });

  it("S&P path: USD closes converted through the FX series (INR view)", () => {
    const r = benchmark(invest, { date: "2026-01-01", amount: 10000 }, {
      closes: { "2025-01-01": 500, "2026-01-01": 500 },
      fx: { "2024-12-31": 83, "2026-01-01": 94 }, // FX lookup also falls back
    });
    expect(r.benchmarkTerminal).toBeCloseTo((10000 * 94) / 83);
    expect(r.benchmarkXirr).toBeCloseTo(94 / 83 - 1, 9);
  });

  it("multi-flow PME: later buy and partial sale replicate as index units", () => {
    // units: +100 @100, +50 @120 → 150, −25 @120 (sell 3000) → 125; terminal 125 × 130.
    const r = benchmark(
      [
        { date: "2025-01-01", amount: -10000 },
        { date: "2025-04-01", amount: -6000 },
        { date: "2025-07-01", amount: 3000 },
      ],
      { date: "2026-01-01", amount: 15000 },
      { closes: { "2025-01-01": 100, "2025-04-01": 120, "2025-07-01": 120, "2026-01-01": 130 } },
    );
    expect(r.method).toBe("pme");
    expect(r.benchmarkTerminal).toBeCloseTo(125 * 130);
  });

  it("replicated units go negative → direct-alpha fallback", () => {
    const flows = [
      { date: "2025-01-01", amount: -1000 },
      { date: "2025-07-01", amount: 1200 },
    ];
    const r = benchmark(flows, { date: "2026-01-01", amount: 0 }, {
      closes: { "2025-01-01": 100, "2025-07-01": 105, "2026-01-01": 110 },
    });
    expect(r.method).toBe("direct-alpha");
    expect(r.benchmarkXirr).toBeNull();
    expect(r.benchmarkTerminal).toBeNull();
    // Flows compounded to the end date by the index: −1100 and +1200×110/105.
    const fvIrr = Math.pow((1200 * 110) / 105 / 1100, 365 / 181) - 1;
    expect(r.alpha).toBeCloseTo(fvIrr, 6);
    expect(r.portfolioXirr).toBeCloseTo(Math.pow(1.2, 365 / 181) - 1, 6);
  });

  it("no index close on or before a flow date → throws", () => {
    expect(() =>
      benchmark(invest, { date: "2026-01-01", amount: 1 }, { closes: { "2025-02-01": 100 } }),
    ).toThrow(/no close/);
  });
});
