import { describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth/access";
import { ev } from "@/lib/ledger/__fixtures__/ev";

// buildTrades is pure; the DB and auth modules are only imported for the loader.
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/auth/access", () => ({ requireActor: vi.fn(), getActor: vi.fn() }));

const { buildTrades } = await import("./trades");
type TradesInputs = import("./trades").TradesInputs;
type TradeFilters = import("./trades").TradeFilters;

const owner: Actor = { kind: "owner", email: "o@example.com", hideAmounts: false, via: "session" };
const hidden: Actor = { kind: "viewer", hideAmounts: true, via: "share-link" };
const ALL: TradeFilters = { market: "all", type: "all", history: false };

const inferred = ev({ instrumentId: "INFY", type: "sell", date: "2026-11-03", qty: 6, price: 120, source: "inferred", approximate: true, id: "inf" });
const manual = ev({ instrumentId: "INFY", type: "sell", date: "2026-11-03", qty: 6, price: 130, source: "manual", id: "man" });
const buy = ev({ instrumentId: "INFY", type: "buy", date: "2026-11-02", qty: 10, price: 100, id: "b1", executedAt: "2026-11-02T10:00:00+05:30" });
const usBuy = ev({ instrumentId: "AAPL", type: "buy", date: "2026-11-04", qty: 2, price: 200, currency: "USD", fxRateInr: 84, source: "us_history", id: "u1" });
const split = ev({ instrumentId: "INFY", type: "split", date: "2026-11-05", exDate: "2026-11-04", qty: 4, ratio: { num: 2, den: 1 }, id: "sp" });
const inputs: TradesInputs = {
  events: [buy, inferred, manual, usBuy, split],
  supersessions: [{ supersededId: "inf", supersedingId: "man" }],
  instruments: [
    { id: "INFY", symbol: "INFY", name: "Infosys", market: "IN", currency: "INR" },
    { id: "AAPL", symbol: "AAPL", name: "Apple", market: "US", currency: "USD" },
  ],
};

describe("buildTrades", () => {
  it("hides superseded events by default and counts them", () => {
    const v = buildTrades(inputs, owner, ALL);
    expect(v.rows.map((r) => r.id)).toEqual(["sp", "u1", "man", "b1"]);
    expect(v.hiddenSuperseded).toBe(1);
    expect(v.rows.find((r) => r.id === "man")?.amountInr).toBe(780);
    expect(v.rows.find((r) => r.id === "u1")?.amountInr).toBe(2 * 200 * 84);
  });

  it("history toggle shows the superseded event, marked with what replaced it", () => {
    const v = buildTrades(inputs, owner, { ...ALL, history: true });
    const old = v.rows.find((r) => r.id === "inf")!;
    expect(old.superseded).toBe(true);
    expect(old.replacedBy).toEqual(["manual"]);
    expect(old.approximate).toBe(true);
    expect(v.hiddenSuperseded).toBe(0);
  });

  it("filters by market and type; a split is an action with a ratio and no price", () => {
    expect(buildTrades(inputs, owner, { ...ALL, market: "us" }).rows.map((r) => r.id)).toEqual(["u1"]);
    expect(buildTrades(inputs, owner, { ...ALL, type: "sell" }).rows.map((r) => r.id)).toEqual(["man"]);
    const [a] = buildTrades(inputs, owner, { ...ALL, type: "action" }).rows;
    expect(a).toMatchObject({ id: "sp", ratio: "2:1", price: null, exDate: "2026-11-04", amountInr: null });
  });

  it("hide-amounts keeps symbol, side, date, price and source but drops qty and amounts", () => {
    const v = buildTrades(inputs, hidden, ALL);
    expect(v.amountsHidden).toBe(true);
    const row = v.rows.find((r) => r.id === "man")!;
    expect(row).toMatchObject({ symbol: "INFY", type: "sell", date: "2026-11-03", price: 130, source: "manual" });
    const json = JSON.stringify(v);
    for (const key of ["qty", "amountNative", "amountInr"]) expect(json).not.toMatch(new RegExp(`"${key}":`));
  });
});

describe("buildDailyTrades", async () => {
  const { buildDailyTrades } = await import("./trades");
  const NOW = new Date("2026-11-13T09:00:00Z"); // 14:30 IST, Fri 13 Nov
  const day: TradesInputs = {
    events: [
      ev({ type: "buy", date: "2026-11-13", qty: 10, price: 100, id: "t-buy", executedAt: "2026-11-13T10:00:00+05:30" }),
      ev({ type: "sell", date: "2026-11-13", qty: 4, price: 110, id: "t-sell", executedAt: "2026-11-13T13:00:00+05:30" }),
      // 15:30 New York on the 12th = 02:00 IST on the 13th → today in IST.
      ev({ instrumentId: "AAPL", type: "buy", date: "2026-11-12", qty: 2, price: 200, currency: "USD", fxRateInr: 84, id: "t-us", executedAt: "2026-11-12T15:30:00-05:00" }),
      ev({ type: "buy", date: "2026-11-11", qty: 1, price: 90, source: "csv", id: "e-csv" }),
      ev({ instrumentId: "AAPL", type: "sell", date: "2026-11-10", qty: 1, price: 210, currency: "USD", fxRateInr: 84, source: "us_history", id: "e-us" }),
      // Excluded: bootstrap opening, inferred diff, superseded fill, dividend, split, manual, out of window.
      ev({ type: "opening", date: "2026-11-13", qty: 50, price: 80, source: "opening", id: "x-open" }),
      ev({ type: "sell", date: "2026-11-13", qty: 3, price: 100, source: "inferred", approximate: true, id: "x-inf" }),
      ev({ type: "buy", date: "2026-11-12", qty: 5, price: 95, id: "x-old", executedAt: "2026-11-12T11:00:00+05:30" }),
      ev({ type: "buy", date: "2026-11-12", qty: 5, price: 96, source: "csv", id: "x-new", executedAt: "2026-11-12T11:00:00+05:30" }),
      ev({ type: "dividend", date: "2026-11-13", qty: 10, price: 5, id: "x-div" }),
      ev({ type: "split", date: "2026-11-13", qty: 10, ratio: { num: 2, den: 1 }, id: "x-split" }),
      ev({ type: "buy", date: "2026-10-01", qty: 1, price: 1, id: "x-window" }),
    ],
    supersessions: [{ supersededId: "x-old", supersedingId: "x-new" }],
    instruments: inputs.instruments,
  };

  it("today first (IST), only real executions, superseded and bootstrap/inferred rows excluded", () => {
    const v = buildDailyTrades(day, owner, NOW);
    expect(v.today.date).toBe("2026-11-13");
    expect(v.today.rows.map((r) => r.id)).toEqual(["t-sell", "t-buy", "t-us"]);
    expect(v.earlier).toEqual([
      { date: "2026-11-12", rows: [expect.objectContaining({ id: "x-new", side: "buy", source: "csv" })] },
      { date: "2026-11-11", rows: [expect.objectContaining({ id: "e-csv", executedAt: "2026-11-11" })] },
      { date: "2026-11-10", rows: [expect.objectContaining({ id: "e-us", market: "US", valueInr: 210 * 84 })] },
    ]);
    const ids = JSON.stringify(v);
    for (const x of ["x-open", "x-inf", "x-old", "x-div", "x-split", "x-window"]) expect(ids).not.toContain(x);
  });

  it("today's totals in INR and per-row values", () => {
    const v = buildDailyTrades(day, owner, NOW);
    expect(v.today.buyValueInr).toBe(1000 + 2 * 200 * 84);
    expect(v.today.sellValueInr).toBe(440);
    expect(v.today.rows[0]).toMatchObject({ symbol: "INFY", qty: 4, price: 110, valueNative: 440, valueInr: 440 });
    expect(v.markets).toEqual({ IN: { open: true }, US: { open: false } });
  });

  it("empty day still returns today; window respects `days`", () => {
    const v = buildDailyTrades(day, owner, new Date("2026-11-15T06:00:00Z"), 3);
    expect(v.today).toMatchObject({ date: "2026-11-15", rows: [], buyValueInr: 0, sellValueInr: 0 });
    expect(v.earlier.map((g) => g.date)).toEqual(["2026-11-13"]);
  });

  it("hide-amounts drops qty, values and totals but keeps side, price and time", () => {
    const v = buildDailyTrades(day, hidden, NOW);
    expect(v.amountsHidden).toBe(true);
    expect(v.today.rows[0]).toMatchObject({ id: "t-sell", side: "sell", price: 110, executedAt: "2026-11-13T13:00:00+05:30" });
    const json = JSON.stringify(v);
    for (const key of ["qty", "valueNative", "valueInr", "buyValueInr", "sellValueInr"]) expect(json).not.toMatch(new RegExp(`"${key}":`));
  });
});
