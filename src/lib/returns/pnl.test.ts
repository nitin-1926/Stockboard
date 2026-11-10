import { describe, expect, it } from "vitest";
import {
  dividendIncome,
  heldQtyOn,
  positionPnl,
  sellFifo,
  US_DIVIDEND_WITHHOLDING,
} from "./pnl";
import type { Lot } from "./types";

const inLot = (qty: number, cost: number, openDate: string): Lot => ({
  instrumentId: "INFY",
  market: "IN",
  currency: "INR",
  qty,
  costPerShare: cost,
  openDate,
  fxRateAtOpen: 1,
  closed: [],
});

const usLot = (qty: number, cost: number, openDate: string, fx: number): Lot => ({
  instrumentId: "AAPL",
  market: "US",
  currency: "USD",
  qty,
  costPerShare: cost,
  openDate,
  fxRateAtOpen: fx,
  closed: [],
});

describe("sellFifo", () => {
  it("partial sell closes the earliest lot first", () => {
    const lots = [inLot(10, 120, "2025-06-01"), inLot(10, 100, "2025-01-01")];
    const after = sellFifo(lots, { date: "2025-09-01", qty: 5, pricePerShare: 150, fxRate: 1 });
    const early = after.find((l) => l.openDate === "2025-01-01")!;
    const late = after.find((l) => l.openDate === "2025-06-01")!;
    expect(early.closed).toEqual([
      { qty: 5, date: "2025-09-01", pricePerShare: 150, fxRate: 1 },
    ]);
    expect(late.closed).toEqual([]);
    expect(lots[1].closed).toEqual([]); // input not mutated
  });

  it("sell spanning two lots splits across them", () => {
    const after = sellFifo([inLot(10, 100, "2025-01-01"), inLot(10, 120, "2025-06-01")], {
      date: "2025-09-01",
      qty: 15,
      pricePerShare: 150,
      fxRate: 1,
    });
    expect(after.map((l) => l.closed.map((c) => c.qty))).toEqual([[10], [5]]);
  });

  it("selling more than open quantity throws (ledger clamps first)", () => {
    expect(() =>
      sellFifo([inLot(10, 100, "2025-01-01")], {
        date: "2025-09-01",
        qty: 11,
        pricePerShare: 150,
        fxRate: 1,
      }),
    ).toThrow(/exceeds open/);
  });
});

describe("positionPnl", () => {
  it("FIFO partial sell: realized uses earliest lot cost, unrealized the rest (INR)", () => {
    const lots = sellFifo([inLot(10, 100, "2025-01-01"), inLot(10, 120, "2025-06-01")], {
      date: "2025-09-01",
      qty: 5,
      pricePerShare: 150,
      fxRate: 1,
    });
    const p = positionPnl({ lots, price: 140, fxNow: 1, asOf: "2026-01-01" });
    expect(p.openQty).toBe(15);
    expect(p.realizedNative).toBeCloseTo(5 * (150 - 100));
    expect(p.realizedInr).toBeCloseTo(250);
    expect(p.unrealizedNative).toBeCloseTo(5 * 40 + 10 * 20);
    expect(p.unrealizedInr).toBeCloseTo(400);
    expect(p.costNative).toBeCloseTo(5 * 100 + 10 * 120);
    expect(p.valueInr).toBeCloseTo(15 * 140);
    expect(p.totalReturnInr).toBeCloseTo(650);
  });

  it("US lot: native and INR P&L use buy-date and sell-date FX", () => {
    const lots = sellFifo([usLot(10, 150, "2025-01-01", 83)], {
      date: "2025-06-01",
      qty: 4,
      pricePerShare: 170,
      fxRate: 90,
    });
    const p = positionPnl({ lots, price: 160, fxNow: 94, asOf: "2026-01-01" });
    expect(p.realizedNative).toBeCloseTo(80);
    expect(p.realizedInr).toBeCloseTo(4 * (170 * 90 - 150 * 83)); // 11400
    expect(p.unrealizedNative).toBeCloseTo(60);
    expect(p.unrealizedInr).toBeCloseTo(6 * (160 * 94 - 150 * 83)); // 15540
    expect(p.costInr).toBeCloseTo(6 * 150 * 83);
  });

  it("emits investor-sign cash flows: buys, sells, dividends, terminal value", () => {
    const lots = sellFifo([usLot(10, 150, "2025-01-01", 83)], {
      date: "2025-06-01",
      qty: 4,
      pricePerShare: 170,
      fxRate: 90,
    });
    const p = positionPnl({
      lots,
      price: 160,
      fxNow: 94,
      asOf: "2026-01-01",
      dividends: [
        { exDate: "2025-08-01", payDate: "2025-08-15", perShareGross: 1, currency: "USD", fxRate: 90 },
      ],
      withholdingRate: US_DIVIDEND_WITHHOLDING,
    });
    expect(p.flows).toEqual([
      { date: "2025-01-01", amountNative: -1500, amountInr: -124500 },
      { date: "2025-06-01", amountNative: 680, amountInr: 61200 },
      { date: "2025-08-15", amountNative: 4.5, amountInr: 405 },
      { date: "2026-01-01", amountNative: 960, amountInr: 90240 },
    ]);
  });
});

describe("dividends", () => {
  it("₹10/share on 50 held → ₹500 gross; India TDS 10% → ₹450 net", () => {
    const d = dividendIncome(
      [inLot(50, 100, "2025-01-01")],
      { exDate: "2025-06-01", perShareGross: 10, currency: "INR", fxRate: 1 },
      0.1,
    );
    expect(d).toMatchObject({ date: "2025-06-01", qty: 50 });
    expect(d.grossInr).toBeCloseTo(500);
    expect(d.netInr).toBeCloseTo(450);
  });

  it("US $1/share on 10 held at fx 90, 25% withheld → ₹675 net, gross kept", () => {
    const d = dividendIncome(
      [usLot(10, 150, "2025-01-01", 83)],
      { exDate: "2025-06-01", payDate: "2025-06-10", perShareGross: 1, currency: "USD", fxRate: 90 },
      US_DIVIDEND_WITHHOLDING,
    );
    expect(d.date).toBe("2025-06-10");
    expect(d.grossNative).toBeCloseTo(10);
    expect(d.netNative).toBeCloseTo(7.5);
    expect(d.grossInr).toBeCloseTo(900);
    expect(d.netInr).toBeCloseTo(675);
  });

  it("ex-date eligibility: bought on ex-date excluded; sold on ex-date still paid", () => {
    const sold = sellFifo([inLot(10, 100, "2025-01-01")], {
      date: "2025-06-01",
      qty: 4,
      pricePerShare: 120,
      fxRate: 1,
    });
    const soldBefore = sellFifo([inLot(10, 100, "2025-01-01")], {
      date: "2025-05-31",
      qty: 4,
      pricePerShare: 120,
      fxRate: 1,
    });
    expect(heldQtyOn([...sold, inLot(7, 100, "2025-06-01")], "2025-06-01")).toBe(10);
    expect(heldQtyOn(soldBefore, "2025-06-01")).toBe(6);
  });

  it("net dividends count toward total return", () => {
    const p = positionPnl({
      lots: [inLot(50, 100, "2025-01-01")],
      price: 100,
      fxNow: 1,
      asOf: "2026-01-01",
      dividends: [{ exDate: "2025-06-01", perShareGross: 10, currency: "INR", fxRate: 1 }],
      withholdingRate: 0.1,
    });
    expect(p.dividendsGrossInr).toBeCloseTo(500);
    expect(p.dividendsNetInr).toBeCloseTo(450);
    expect(p.totalReturnInr).toBeCloseTo(450);
  });
});
