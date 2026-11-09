import { describe, expect, it } from "vitest";
import { ev, snap } from "./__fixtures__/ev";
import { inferFromSnapshot } from "./infer";
import { replay } from "./lots";
import type { CorporateAction, LedgerEvent, Snapshot } from "./types";

const D = "2026-11-10"; // Tuesday
const opening = (qty: number, price: number) =>
  ev({ id: "open", type: "opening", source: "opening", date: "2026-11-09", qty, price });
const r1 = (qty: number, avg: number) => snap("r1", "2026-11-09T15:45:00+05:30", qty, avg);

const infer = (events: LedgerEvent[], prev: Snapshot | null, curr: Snapshot, actions?: CorporateAction[]) =>
  inferFromSnapshot({ events, prev, curr, priceForDate: 120, currency: "INR", fxRateInr: 1, actions });

describe("inferFromSnapshot", () => {
  it("first snapshot becomes an approximate opening event at its avg price", () => {
    const r = infer([], null, r1(10, 100));
    expect(r.events).toEqual([
      expect.objectContaining({
        type: "opening",
        source: "opening",
        qty: 10,
        price: 100,
        date: "2026-11-09",
        approximate: true,
        sourceRef: "opening:INFY:r1",
      }),
    ]);
  });

  it("qty 10 → 15 with avg rising: buy 5 at (15×avg₂ − 10×avg₁)/5, approximate", () => {
    const r = infer([opening(10, 100)], r1(10, 100), snap("r2", `${D}T15:45:00+05:30`, 15, 110));
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({
      type: "buy",
      source: "inferred",
      qty: 5,
      date: D,
      approximate: true,
      sourceRef: "inferred:INFY:r1:r2",
    });
    expect(r.events[0].price).toBeCloseTo((15 * 110 - 10 * 100) / 5);
  });

  it("qty 15 → 10: sell 5 at the caller-supplied close, approximate", () => {
    const r = infer([opening(15, 110)], r1(15, 110), snap("r2", `${D}T15:45:00+05:30`, 10, 110));
    expect(r.events[0]).toMatchObject({ type: "sell", qty: 5, price: 120, approximate: true });
  });

  it("full exit (qty → 0) infers a sell of everything", () => {
    const r = infer([opening(10, 100)], r1(10, 100), snap("r2", `${D}T15:45:00+05:30`, 0, 0));
    expect(r.events[0]).toMatchObject({ type: "sell", qty: 10, price: 120 });
  });

  it("a fill already explains the change: no inferred event", () => {
    const fill = ev({ type: "buy", date: D, executedAt: `${D}T10:00:00+05:30`, qty: 5, price: 130 });
    const r = infer([opening(10, 100), fill], r1(10, 100), snap("r2", `${D}T15:45:00+05:30`, 15, 110));
    expect(r.events).toEqual([]);
    expect(r.residual).toBe(0);
  });

  it("top-up lag: fill on D, D 15:45 snapshot still 10 → pendingLag, no double count", () => {
    const events = [opening(10, 100), ev({ type: "buy", date: D, executedAt: `${D}T10:00:00+05:30`, qty: 5, price: 130 })];
    const lag = infer(events, r1(10, 100), snap("r2", `${D}T15:45:00+05:30`, 10, 100));
    expect(lag).toMatchObject({ events: [], pendingLag: true });
    const next = infer(events, snap("r2", `${D}T15:45:00+05:30`, 10, 100), snap("r3", "2026-11-11T08:00:00+05:30", 15, 110));
    expect(next.events).toEqual([]);
    expect(next.pendingLag).toBeFalsy();
  });

  it("lag window expires after 2 trading days → the gap is inferred", () => {
    const events = [opening(10, 100), ev({ type: "buy", date: D, executedAt: `${D}T10:00:00+05:30`, qty: 5, price: 130 })];
    const r = infer(events, r1(10, 100), snap("r5", "2026-11-13T15:45:00+05:30", 10, 100));
    expect(r.pendingLag).toBeFalsy();
    expect(r.events[0]).toMatchObject({ type: "sell", qty: 5 });
  });

  it("is idempotent: same snapshot pair → same sourceRef; once ingested, nothing new", () => {
    const curr = snap("r2", `${D}T15:45:00+05:30`, 15, 110);
    const a = infer([opening(10, 100)], r1(10, 100), curr);
    const b = infer([opening(10, 100)], r1(10, 100), curr);
    expect(a.events[0].sourceRef).toBe(b.events[0].sourceRef);
    expect(infer([opening(10, 100), ...a.events], r1(10, 100), curr).events).toEqual([]);
  });

  it("nonsensical buy price falls back to the snapshot avg and is flagged", () => {
    const r = infer([opening(10, 100)], r1(10, 100), snap("r2", `${D}T15:45:00+05:30`, 12, 50));
    expect(r.events[0]).toMatchObject({ type: "buy", qty: 2, price: 50 });
    expect(r.anomalies[0].kind).toBe("price_fallback");
  });

  it("prices buys on the broker's weighted-average basis, not FIFO remaining cost", () => {
    const events = [
      ev({ type: "buy", date: "2025-01-10", qty: 10, price: 100 }),
      ev({ type: "buy", date: "2025-02-10", qty: 10, price: 200 }),
      ev({ type: "sell", date: "2025-03-10", qty: 10, price: 250 }),
    ];
    // Broker avg stays 150 after the sell; a buy of 10 at 150 keeps it 150.
    const r = infer(events, snap("r1", "2025-03-11T15:45:00+05:30", 10, 150), snap("r2", "2025-03-12T15:45:00+05:30", 20, 150));
    expect(r.events[0].price).toBeCloseTo(150);
  });

  it("2:1 split on the day, cost preserved → split event only, lots doubled", () => {
    const split: CorporateAction = { instrumentId: "INFY", exDate: D, ratio: { num: 2, den: 1 }, kind: "split" };
    const r = infer([opening(10, 100)], r1(10, 100), snap("r2", `${D}T15:45:00+05:30`, 20, 50), [split]);
    expect(r.events).toEqual([expect.objectContaining({ type: "split", exDate: D, sourceRef: `action:INFY:${D}` })]);
    const lots = replay([opening(10, 100), ...r.events]).openLots;
    expect(lots[0]).toMatchObject({ qty: 20, costPerShare: 50, openDate: "2026-11-09" });
  });

  it("split + buy: cost not preserved → split event plus an inferred buy for the remainder", () => {
    const split: CorporateAction = { instrumentId: "INFY", exDate: D, ratio: { num: 2, den: 1 }, kind: "split" };
    const r = infer([opening(10, 100)], r1(10, 100), snap("r2", `${D}T15:45:00+05:30`, 25, 52), [split]);
    expect(r.events.map((e) => e.type)).toEqual(["split", "buy"]);
    expect(r.events[1].qty).toBeCloseTo(5);
    expect(r.events[1].price).toBeCloseTo((25 * 52 - 1000) / 5);
    expect(replay([opening(10, 100), ...r.events]).positions.INFY.qty).toBeCloseTo(25);
  });

  it("bonus credited 2 trading days after the ex-date: matched via the window, lot dated at allotment", () => {
    const bonus: CorporateAction = { instrumentId: "INFY", exDate: "2026-11-06", ratio: { num: 2, den: 1 }, kind: "bonus" };
    const events = [ev({ id: "open", type: "opening", source: "opening", date: "2026-11-02", qty: 10, price: 100 })];
    const r = infer(events, snap("r1", "2026-11-09T15:45:00+05:30", 10, 100), snap("r2", `${D}T15:45:00+05:30`, 20, 50), [bonus]);
    expect(r.events).toEqual([expect.objectContaining({ type: "bonus", date: D, exDate: "2026-11-06" })]);
    const lots = replay([...events, ...r.events]).openLots;
    expect(lots[1]).toMatchObject({ qty: 10, costPerShare: 0, openDate: D });
  });

  it("qty jump with cost preserved and no known action → unexplained, nothing written", () => {
    const r = infer([opening(10, 100)], r1(10, 100), snap("r2", `${D}T15:45:00+05:30`, 20, 50));
    expect(r.events).toEqual([]);
    expect(r.unexplained).toMatch(/corporate action/);
  });
});
