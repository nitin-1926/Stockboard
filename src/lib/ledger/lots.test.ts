import { describe, expect, it } from "vitest";
import { ltcgEligibleDate } from "@/lib/returns/tax";
import { ev } from "./__fixtures__/ev";
import { replay } from "./lots";

const openQty = (l: { qty: number; closed: { qty: number }[] }) =>
  l.qty - l.closed.reduce((s, c) => s + c.qty, 0);

describe("replay", () => {
  it("FIFO partial sell realizes against the earliest lot", () => {
    const r = replay([
      ev({ type: "buy", date: "2025-01-10", qty: 10, price: 100 }),
      ev({ type: "buy", date: "2025-02-10", qty: 10, price: 200 }),
      ev({ type: "sell", date: "2025-03-10", qty: 15, price: 300 }),
    ]);
    expect(r.openLots).toHaveLength(1);
    expect(r.openLots[0].openDate).toBe("2025-02-10");
    expect(openQty(r.openLots[0])).toBe(5);
    expect(r.closedLots).toHaveLength(1);
    // 10×(300−100) + 5×(300−200)
    expect(r.realized.INFY.native).toBeCloseTo(2500);
    expect(r.realized.INFY.inr).toBeCloseTo(2500);
    // Weighted-average basis (broker convention): 20 @150, sell 15 → 5 @150.
    expect(r.positions.INFY).toEqual({ qty: 5, cost: 750 });
  });

  it("2:1 split doubles earlier open lots, halves price, keeps the acquisition date", () => {
    const r = replay([
      ev({ type: "buy", date: "2025-01-10", qty: 10, price: 100 }),
      ev({ type: "split", date: "2025-06-03", exDate: "2025-06-01", qty: 10, ratio: { num: 2, den: 1 } }),
      ev({ type: "buy", date: "2025-06-02", qty: 4, price: 55 }),
    ]);
    const [a, b] = r.openLots;
    expect(a).toMatchObject({ qty: 20, costPerShare: 50, openDate: "2025-01-10" });
    // Bought after the ex-date at a post-split price: untouched.
    expect(b).toMatchObject({ qty: 4, costPerShare: 55 });
    expect(r.positions.INFY).toEqual({ qty: 24, cost: 1220 });
  });

  it("split also rescales the closed portions of a partly sold lot (realized unchanged)", () => {
    const r = replay([
      ev({ type: "buy", date: "2025-01-10", qty: 10, price: 100 }),
      ev({ type: "sell", date: "2025-02-10", qty: 4, price: 200 }),
      ev({ type: "split", date: "2025-06-01", qty: 6, ratio: { num: 2, den: 1 } }),
    ]);
    expect(openQty(r.openLots[0])).toBe(12);
    expect(r.realized.INFY.native).toBeCloseTo(400);
  });

  it("owner reclassified bonus: original lot unchanged, zero-cost lot dated at allotment", () => {
    const r = replay([
      ev({ type: "buy", date: "2024-01-10", qty: 10, price: 100 }),
      ev({ type: "bonus", date: "2025-06-04", exDate: "2025-06-02", qty: 10, ratio: { num: 2, den: 1 } }),
    ]);
    expect(r.openLots).toHaveLength(2);
    expect(r.openLots[0]).toMatchObject({ qty: 10, costPerShare: 100, openDate: "2024-01-10" });
    expect(r.openLots[1]).toMatchObject({ qty: 10, costPerShare: 0, openDate: "2025-06-04" });
    // LTCG clock for the bonus lot starts at allotment, not the ex-date.
    expect(ltcgEligibleDate(r.openLots[1].openDate, "IN")).toBe("2026-06-05");
    expect(r.positions.INFY).toEqual({ qty: 20, cost: 1000 });
  });

  it("bonus counts holdings at the ex-date, not trades between ex-date and allotment", () => {
    const r = replay([
      ev({ type: "buy", date: "2024-01-10", qty: 10, price: 100 }),
      ev({ type: "buy", date: "2025-06-03", qty: 6, price: 52 }),
      ev({ type: "bonus", date: "2025-06-04", exDate: "2025-06-02", qty: 10, ratio: { num: 2, den: 1 } }),
    ]);
    expect(r.openLots.map((l) => l.qty)).toEqual([10, 6, 10]);
  });

  it("full exit closes every lot but keeps realized P&L", () => {
    const r = replay([
      ev({ type: "opening", source: "opening", date: "2025-01-10", qty: 10, price: 100 }),
      ev({ type: "sell", date: "2025-05-10", qty: 10, price: 130 }),
    ]);
    expect(r.openLots).toEqual([]);
    expect(r.closedLots).toHaveLength(1);
    expect(r.realized.INFY.native).toBeCloseTo(300);
    expect(r.positions.INFY.qty).toBe(0);
  });

  it("oversell is clamped to the open quantity and flagged, never negative", () => {
    const r = replay([
      ev({ type: "buy", date: "2025-01-10", qty: 10, price: 100 }),
      ev({ id: "s1", type: "sell", date: "2025-02-10", qty: 15, price: 120 }),
    ]);
    expect(r.openLots).toEqual([]);
    expect(r.closedLots[0].closed[0].qty).toBe(10);
    expect(r.anomalies).toEqual([expect.objectContaining({ kind: "oversell", eventId: "s1" })]);
    expect(r.positions.INFY.qty).toBe(0);
  });

  it("ignores superseded events", () => {
    const r = replay(
      [
        ev({ id: "inf", type: "buy", source: "inferred", date: "2025-01-10", qty: 5, price: 99 }),
        ev({ id: "fill", type: "buy", date: "2025-01-10", qty: 5, price: 101 }),
      ],
      [{ supersededId: "inf", supersedingId: "fill" }],
    );
    expect(r.openLots).toHaveLength(1);
    expect(r.openLots[0]).toMatchObject({ eventId: "fill", costPerShare: 101 });
  });

  it("US lot carries its buy-date rate; realized INR uses the sale-date rate", () => {
    const r = replay([
      ev({ instrumentId: "AAPL", currency: "USD", fxRateInr: 83, type: "buy", date: "2025-01-10", qty: 10, price: 150 }),
      ev({ instrumentId: "AAPL", currency: "USD", fxRateInr: 85, type: "sell", date: "2025-03-10", qty: 10, price: 160 }),
    ]);
    expect(r.closedLots[0]).toMatchObject({ market: "US", fxRateAtOpen: 83 });
    expect(r.realized.AAPL.native).toBeCloseTo(100);
    expect(r.realized.AAPL.inr).toBeCloseTo(10 * 160 * 85 - 10 * 150 * 83);
  });

  it("orders same-day buys before sells and ignores dividend events", () => {
    const r = replay([
      ev({ type: "sell", date: "2025-01-10", qty: 5, price: 110, executedAt: "2025-01-10T09:20:00+05:30" }),
      ev({ type: "buy", date: "2025-01-10", qty: 5, price: 100, executedAt: "2025-01-10T09:30:00+05:30" }),
      ev({ type: "dividend", date: "2025-02-10", qty: 0, price: 5 }),
    ]);
    expect(r.anomalies).toEqual([]);
    expect(r.realized.INFY.native).toBeCloseTo(50);
  });
});
