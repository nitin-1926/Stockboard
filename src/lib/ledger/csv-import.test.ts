import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ev } from "./__fixtures__/ev";
import {
  applyHistoricalActions,
  dateRange,
  parseConsoleTradebook,
  parseUsHistory,
  reconcile,
  toEvents,
  usHistoryToEvents,
} from "./csv-import";
import { replay } from "./lots";
import { planSupersession } from "./supersede";

const fixture = readFileSync(new URL("./__fixtures__/console-tradebook.csv", import.meta.url), "utf8");
const HEADER = fixture.split("\n")[0];
const resolve = (symbol: string) => (symbol === "INFY" ? "INFY" : undefined);

describe("parseConsoleTradebook", () => {
  it("parses the tradebook fixture: 3 buys and 1 sell", () => {
    const { rows, errors } = parseConsoleTradebook(fixture);
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.side)).toEqual(["buy", "buy", "sell", "buy"]);
    expect(rows[0]).toMatchObject({ symbol: "INFY", exchange: "NSE", qty: 10, price: 1520.5, tradeId: "56789012", row: 2 });
  });

  it("rejects an unknown header set outright", () => {
    const bad = fixture.replace("symbol,", "tradingsymbol,");
    const { rows, errors } = parseConsoleTradebook(bad);
    expect(rows).toEqual([]);
    expect(errors).toEqual([{ row: 1, message: expect.stringMatching(/tradingsymbol/) }]);
  });

  it("lists every malformed row by file line number", () => {
    const text = [
      HEADER,
      "INFY,INE009A01021,2024-01-15,NSE,EQ,EQ,buy,false,10,1520.5,1,11,2024-01-15T09:21:44",
      "INFY,INE009A01021,2024-01-16,NSE,EQ,EQ,buy,false,abc,1520.5,2,12,2024-01-16T09:21:44",
      "INFY,INE009A01021,2024-01-17,NSE,EQ,EQ,hold,false,10,1520.5,3,13,2024-01-17T09:21:44",
      "INFY,INE009A01021,2024-13-45,NSE,EQ,EQ,buy,false,10,1520.5,4,14,2024-01-18T09:21:44",
      "INFY,INE009A01021,2024-01-19,NSE,EQ,EQ,buy,false,10",
      "INFY,INE009A01021,2024-01-20,NSE,EQ,EQ,buy,false,10,1520.5,1,15,2024-01-20T09:21:44",
      "",
    ].join("\n");
    const { errors } = parseConsoleTradebook(text);
    expect(errors.map((e) => e.row)).toEqual([3, 4, 5, 6, 7]);
    expect(errors[4].message).toMatch(/duplicate trade_id/);
  });
});

describe("toEvents + supersession + replay", () => {
  it("4 csv events; overlapping inferred superseded; replayed lots match the tradebook", () => {
    const { rows } = parseConsoleTradebook(fixture);
    const { events, errors } = toEvents(rows, (r) => resolve(r.symbol));
    expect(errors).toEqual([]);
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      type: "buy",
      source: "csv",
      sourceRef: "csv:56789012",
      date: "2024-01-15",
      executedAt: "2024-01-15T09:21:44+05:30",
      currency: "INR",
      fxRateInr: 1,
      approximate: false,
    });

    const inferred = ev({ id: "inf", source: "inferred", type: "buy", date: "2024-03-21", qty: 5, price: 1500 });
    const plan = planSupersession([inferred], events);
    expect(plan.supersessions).toEqual([{ supersededId: "inf", supersedingId: "csv:57890123" }]);

    const r = replay([inferred, ...events], plan.supersessions);
    expect(r.openLots.map((l) => [l.openDate, l.qty - l.closed.reduce((s, c) => s + c.qty, 0)])).toEqual([
      ["2024-01-15", 2],
      ["2024-03-20", 5],
      ["2024-09-02", 3],
    ]);
    expect(r.realized.INFY.native).toBeCloseTo(8 * (1610.25 - 1520.5));
  });

  it("unresolved symbols are errors with their row numbers", () => {
    const { rows } = parseConsoleTradebook(fixture);
    const { errors } = toEvents(rows, () => undefined);
    expect(errors.map((e) => e.row)).toEqual([2, 3, 4, 5]);
  });

  it("dateRange gives the min/max so FX can be prefetched before the transaction", () => {
    const { events } = toEvents(parseConsoleTradebook(fixture).rows, (r) => resolve(r.symbol));
    expect(dateRange(events)).toEqual({ from: "2024-01-15", to: "2024-09-02" });
    expect(dateRange([])).toBeNull();
  });
});

describe("reconcile", () => {
  const base = { instrumentId: "INFY", date: "2026-11-11", currency: "INR" as const, fxRateInr: 1 };

  it("replayed qty below broker → unexplained opening for the residual, flagged", () => {
    const r = reconcile({ ...base, replayedQty: 10, replayedCost: 15000, brokerQty: 12, brokerAvg: 1550 });
    expect(r.residual).toBe(2);
    expect(r.event).toMatchObject({ type: "opening", source: "opening", qty: 2, approximate: true, sourceRef: "reconcile:INFY:2026-11-11" });
    expect(r.event?.price).toBeCloseTo((12 * 1550 - 15000) / 2);
    expect(r.anomaly?.kind).toBe("unexplained_opening");
  });

  it("matching qty → nothing to do", () => {
    expect(reconcile({ ...base, replayedQty: 10, replayedCost: 15000, brokerQty: 10, brokerAvg: 1500 })).toEqual({ residual: 0 });
  });

  it("replayed qty above broker → flagged, no event", () => {
    const r = reconcile({ ...base, replayedQty: 10, replayedCost: 15000, brokerQty: 8, brokerAvg: 1500 });
    expect(r.event).toBeUndefined();
    expect(r.anomaly?.kind).toBe("exceeds_broker");
  });
});

describe("applyHistoricalActions", () => {
  it("CSV + historical 1:1 bonus replays to the broker's qty", () => {
    const events = [
      ev({ id: "b", source: "csv", type: "buy", date: "2020-01-10", qty: 10, price: 1000 }),
      ev({ id: "s", source: "csv", type: "sell", date: "2022-03-01", qty: 5, price: 600 }),
    ];
    const actions = [
      { instrumentId: "INFY", exDate: "2019-01-01", ratio: { num: 2, den: 1 }, kind: "split" as const },
      { instrumentId: "INFY", exDate: "2021-06-01", ratio: { num: 2, den: 1 }, kind: "bonus" as const },
      { instrumentId: "TCS", exDate: "2021-06-01", ratio: { num: 2, den: 1 }, kind: "split" as const },
    ];
    const all = applyHistoricalActions(events, actions);
    expect(all.filter((e) => e.type === "bonus")).toEqual([
      expect.objectContaining({ date: "2021-06-01", exDate: "2021-06-01", sourceRef: "action:INFY:2021-06-01", approximate: true }),
    ]);
    expect(all).toHaveLength(3);
    const r = replay(all);
    expect(r.positions.INFY.qty).toBe(15);
    expect(reconcile({ instrumentId: "INFY", date: "2026-11-11", currency: "INR", fxRateInr: 1, replayedQty: 15, replayedCost: r.positions.INFY.cost, brokerQty: 15, brokerAvg: 333.33 }).residual).toBe(0);
  });
});

describe("US history (assumed INDmoney CSV, format TBD by U1)", () => {
  it("weekend trade date uses the caller's forward-filled previous business-day rate", () => {
    const text = "date,symbol,side,quantity,price,order_id\n2025-03-08,AAPL,BUY,2,170.5,ORD1\n";
    const { rows, errors } = parseUsHistory(text);
    expect(errors).toEqual([]);
    const ffill: Record<string, number> = { "2025-03-07": 86.9, "2025-03-08": 86.9 };
    const out = usHistoryToEvents(rows, (r) => r.symbol, (d) => ffill[d]);
    expect(out.errors).toEqual([]);
    expect(out.events[0]).toMatchObject({
      instrumentId: "AAPL",
      type: "buy",
      currency: "USD",
      fxRateInr: 86.9,
      source: "us_history",
      sourceRef: "us_history:ORD1",
      qty: 2,
      price: 170.5,
    });
    expect(replay(out.events).openLots[0]).toMatchObject({ market: "US", fxRateAtOpen: 86.9 });
  });

  it("a missing FX rate is an error, never a null rate", () => {
    const { rows } = parseUsHistory("date,symbol,side,quantity,price,order_id\n2025-03-08,AAPL,SELL,2,170.5,ORD1\n");
    expect(usHistoryToEvents(rows, (r) => r.symbol, () => undefined).errors).toEqual([{ row: 2, message: expect.stringMatching(/FX/) }]);
  });
});
