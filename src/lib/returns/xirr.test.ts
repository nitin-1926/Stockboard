import { describe, expect, it } from "vitest";
import { annualizeOrAbsolute, daysBetween, xirr, xirrNewton } from "./xirr";

describe("xirr", () => {
  it("one year, +10% → 0.10", () => {
    const r = xirr([
      { date: "2025-01-01", amount: -10000 },
      { date: "2026-01-01", amount: 11000 },
    ]);
    expect(r).toBeCloseTo(0.1, 9);
  });

  // Microsoft's documented Excel XIRR example; Excel returns 0.373362535.
  it("matches Excel on an irregular multi-flow fixture within 1e-6", () => {
    const r = xirr([
      { date: "2008-01-01", amount: -10000 },
      { date: "2008-03-01", amount: 2750 },
      { date: "2008-10-30", amount: 4250 },
      { date: "2009-02-15", amount: 3250 },
      { date: "2009-04-01", amount: 2750 },
    ]);
    expect(Math.abs(r! - 0.373362535)).toBeLessThan(1e-6);
  });

  it("is order-independent", () => {
    const r = xirr([
      { date: "2026-01-01", amount: 11000 },
      { date: "2025-01-01", amount: -10000 },
    ]);
    expect(r).toBeCloseTo(0.1, 9);
  });

  it("all-negative, all-positive, single or empty flows → null", () => {
    expect(
      xirr([
        { date: "2025-01-01", amount: -1 },
        { date: "2026-01-01", amount: -2 },
      ]),
    ).toBeNull();
    expect(
      xirr([
        { date: "2025-01-01", amount: 1 },
        { date: "2026-01-01", amount: 2 },
      ]),
    ).toBeNull();
    expect(xirr([{ date: "2025-01-01", amount: -1 }])).toBeNull();
    expect(xirr([])).toBeNull();
  });

  // Newton from 0.1 overshoots below -100% on a 99% loss; bisection rescues it.
  it("pathological: Newton diverges, bisection still converges", () => {
    const flows = [
      { date: "2025-01-01", amount: -10000 },
      { date: "2026-01-01", amount: 100 },
    ];
    expect(xirrNewton(flows)).toBeNull();
    expect(xirr(flows)).toBeCloseTo(-0.99, 6);
  });

  it("returns null when no root lies in [-0.9999, 10] and Newton fails", () => {
    // Loss of more than 99.99% in a year: root below the bracket.
    expect(
      xirr([
        { date: "2025-01-01", amount: -1_000_000 },
        { date: "2026-01-01", amount: 1 },
      ]),
    ).toBeNull();
  });
});

describe("daysBetween", () => {
  it("counts calendar days across a leap year", () => {
    expect(daysBetween("2024-01-01", "2025-01-01")).toBe(366);
    expect(daysBetween("2025-01-01", "2026-01-01")).toBe(365);
  });
});

describe("annualizeOrAbsolute", () => {
  it("span of 10 days → useAbsolute with absolute return, no xirr", () => {
    expect(
      annualizeOrAbsolute([
        { date: "2026-01-01", amount: -1000 },
        { date: "2026-01-11", amount: 1100 },
      ]),
    ).toEqual({ useAbsolute: true, absolute: expect.closeTo(0.1, 9), xirr: null });
  });

  it("364 days → absolute; 365 days → xirr", () => {
    expect(
      annualizeOrAbsolute([
        { date: "2025-01-01", amount: -1000 },
        { date: "2025-12-31", amount: 1100 },
      ]).useAbsolute,
    ).toBe(true);
    const r = annualizeOrAbsolute([
      { date: "2025-01-01", amount: -1000 },
      { date: "2026-01-01", amount: 1100 },
    ]);
    expect(r.useAbsolute).toBe(false);
    expect(r.xirr).toBeCloseTo(0.1, 9);
    expect(r.absolute).toBeCloseTo(0.1, 9);
  });

  it("absolute = money out / money in − 1 across many flows", () => {
    const r = annualizeOrAbsolute([
      { date: "2026-01-01", amount: -1000 },
      { date: "2026-01-05", amount: -500 },
      { date: "2026-01-07", amount: 300 },
      { date: "2026-01-11", amount: 1500 },
    ]);
    expect(r.absolute).toBeCloseTo(1800 / 1500 - 1, 9);
  });

  it("no money in → absolute null", () => {
    expect(annualizeOrAbsolute([]).absolute).toBeNull();
  });
});
