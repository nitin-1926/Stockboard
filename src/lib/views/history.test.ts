import { describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth/access";
import { ev } from "@/lib/ledger/__fixtures__/ev";
import type { LedgerEvent } from "@/lib/ledger/types";

// buildHistory is pure; the DB and auth modules are only imported for the loader.
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/auth/access", () => ({ requireActor: vi.fn(), getActor: vi.fn() }));

const { buildHistory } = await import("./history");
type HistoryInputs = import("./history").HistoryInputs;
type HistoryInstrument = import("./history").HistoryInstrument;

const owner: Actor = { kind: "owner", email: "o@example.com", hideAmounts: false, via: "session" };
const hidden: Actor = { kind: "viewer", hideAmounts: true, via: "share-link" };

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
/** Weekdays from `from` to `to` inclusive. */
function weekdays(from: string, to: string) {
  const out: string[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += DAY) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(iso(t));
  }
  return out;
}
const inst = (id: string, closes: [string, number][], market: "IN" | "US" = "IN"): HistoryInstrument => ({
  id,
  market,
  currency: market === "IN" ? "INR" : "USD",
  closes: closes.map(([date, close]) => ({ date, close })),
});
const inputs = (o: Partial<HistoryInputs>): HistoryInputs => ({
  instruments: [],
  events: [],
  supersessions: [],
  actions: [],
  fx: [],
  today: "2026-11-11",
  ...o,
});
const pointsOf = (v: ReturnType<typeof buildHistory>, scope: "all" | "in" | "us" = "all") => v.scopes[scope].points;

describe("buildHistory", () => {
  it("range 1Y → points ordered by date, inside the last year, weekends absent", () => {
    const days = weekdays("2024-06-03", "2026-11-11");
    const v = buildHistory(
      inputs({
        instruments: [inst("A", days.map((d, i) => [d, 100 + i]))],
        events: [ev({ instrumentId: "A", type: "buy", date: "2024-06-03", qty: 10, price: 100 })],
      }),
      owner,
      "1y",
    );
    const pts = pointsOf(v);
    const dates = pts.map((p) => p.date);
    expect(dates).toEqual([...dates].sort());
    expect(dates[0] >= "2025-11-11").toBe(true);
    expect(dates.at(-1)).toBe("2026-11-11");
    expect(dates.every((d) => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()))).toBe(true);
    expect(pts[0].index).toBe(100);
    expect(v.range).toBe("1y");
  });

  it("an IN holiday carries the last IN close in ALL (no zero dip) and is a gap in IN", () => {
    // Wed 2026-11-04 is an IN holiday; the US traded.
    const v = buildHistory(
      inputs({
        instruments: [
          inst("IN1", [
            ["2026-11-02", 100],
            ["2026-11-03", 110],
            ["2026-11-05", 120],
          ]),
          inst(
            "US1",
            [
              ["2026-11-02", 10],
              ["2026-11-03", 10],
              ["2026-11-04", 10],
              ["2026-11-05", 10],
            ],
            "US",
          ),
        ],
        events: [
          ev({ instrumentId: "IN1", type: "buy", date: "2026-11-02", qty: 10, price: 100 }),
          ev({ instrumentId: "US1", type: "buy", date: "2026-11-02", qty: 1, price: 10, currency: "USD", fxRateInr: 80 }),
        ],
        fx: [{ date: "2026-11-02", usdInr: 80 }],
        today: "2026-11-05",
      }),
      owner,
      "all",
    );
    const all = pointsOf(v);
    expect(all.map((p) => p.date)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"]);
    const wed = all[2];
    expect(wed.value).toBeCloseTo(10 * 110 + 800); // Tuesday's IN close carried, not 0
    expect(wed.dayPnl).toBeCloseTo(0);
    expect(all.every((p) => (p.value ?? 0) > 0)).toBe(true);
    expect(pointsOf(v, "in").map((p) => p.date)).toEqual(["2026-11-02", "2026-11-03", "2026-11-05"]);
    expect(pointsOf(v, "us")).toHaveLength(4);
  });

  it("day P&L excludes cash flows: a buy day is not a gain, a sell day not a loss", () => {
    const v = buildHistory(
      inputs({
        instruments: [
          inst("A", [
            ["2026-11-02", 100],
            ["2026-11-03", 105],
            ["2026-11-04", 105],
            ["2026-11-05", 104],
          ]),
        ],
        events: [
          ev({ instrumentId: "A", type: "buy", date: "2026-11-02", qty: 10, price: 100 }),
          ev({ instrumentId: "A", type: "buy", date: "2026-11-03", qty: 10, price: 105 }),
          ev({ instrumentId: "A", type: "sell", date: "2026-11-05", qty: 15, price: 104 }),
        ],
        today: "2026-11-05",
      }),
      owner,
      "all",
    );
    const [d1, d2, d3, d4] = pointsOf(v);
    expect(d1.dayPnl).toBeCloseTo(0); // bought at the close
    expect(d2.value).toBeCloseTo(2100);
    expect(d2.flow).toBeCloseTo(1050);
    expect(d2.dayPnl).toBeCloseTo(50); // only the first 10 shares moved +5
    expect(d2.dayPnlPct).toBeCloseTo(50 / 2050);
    expect(d3.dayPnl).toBeCloseTo(0);
    expect(d4.value).toBeCloseTo(5 * 104);
    expect(d4.flow).toBeCloseTo(-15 * 104);
    expect(d4.dayPnl).toBeCloseTo(-20); // 20 shares × −1, the sale itself is not a loss
    expect(d4.invested).toBeCloseTo(5 * 105); // FIFO: the 100s went first
    expect(v.scopes.all.summary.pnl).toBeCloseTo(50 - 20);
  });

  it("US holdings are converted at each day's FX (weekend FX gap carries the last rate)", () => {
    const v = buildHistory(
      inputs({
        instruments: [
          inst(
            "US1",
            [
              ["2026-11-05", 100],
              ["2026-11-06", 100],
              ["2026-11-09", 100],
            ],
            "US",
          ),
        ],
        events: [ev({ instrumentId: "US1", type: "buy", date: "2026-11-05", qty: 10, price: 100, currency: "USD", fxRateInr: 80 })],
        fx: [
          { date: "2026-11-05", usdInr: 80 },
          { date: "2026-11-06", usdInr: 82 },
        ],
        today: "2026-11-09",
      }),
      owner,
      "all",
    );
    const pts = pointsOf(v);
    expect(pts.map((p) => p.value)).toEqual([80_000, 82_000, 82_000]);
    expect(pts[1].dayPnl).toBeCloseTo(2000); // the FX move, no price move
    expect(pts[1].invested).toBeCloseTo(80_000); // cost stays at the rate on the buy date
  });

  it("an uncredited split (raw close halves, ledger qty unchanged) shows no false drop", () => {
    const v = buildHistory(
      inputs({
        instruments: [
          inst("S", [
            ["2026-11-02", 200],
            ["2026-11-03", 100],
          ]),
        ],
        events: [ev({ instrumentId: "S", type: "buy", date: "2026-10-01", qty: 10, price: 200 })],
        actions: [{ instrumentId: "S", exDate: "2026-11-03", ratio: { num: 2, den: 1 }, kind: "split" }],
        today: "2026-11-03",
      }),
      owner,
      "all",
    );
    expect(pointsOf(v).map((p) => p.value)).toEqual([2000, 2000]);
  });

  it("hide-amounts → indexed series starting at 100, day P&L as % only, no amount fields", () => {
    const v = buildHistory(
      inputs({
        instruments: [
          inst("A", [
            ["2026-11-02", 100],
            ["2026-11-03", 105],
            ["2026-11-04", 102.9],
          ]),
        ],
        events: [ev({ instrumentId: "A", type: "buy", date: "2026-11-02", qty: 10, price: 100 })],
        today: "2026-11-04",
      }),
      hidden,
      "all",
    );
    expect(v.amountsHidden).toBe(true);
    const pts = pointsOf(v);
    expect(pts.map((p) => p.index)).toEqual([100, 105, expect.closeTo(102.9, 6)]);
    expect(pts[1].dayPnlPct).toBeCloseTo(0.05);
    const json = JSON.stringify(v);
    for (const key of ["value", "invested", "flow", "dayPnl", "startValue", "endValue", "pnl"])
      expect(json).not.toMatch(new RegExp(`"${key}":`));
    expect(v.scopes.all.summary.returnPct).toBeCloseTo(0.029);
  });

  it("no events → empty view, every scope empty", () => {
    const v = buildHistory(inputs({}), owner, "1y");
    expect(v.empty).toBe(true);
    expect(pointsOf(v)).toEqual([]);
    expect(v.scopes.in.summary.from).toBeNull();
  });

  it("3 years × 50 instruments builds in well under 200 ms", () => {
    const days = weekdays("2023-11-13", "2026-11-11");
    const instruments: HistoryInstrument[] = [];
    const events: LedgerEvent[] = [];
    for (let i = 0; i < 50; i++) {
      const id = `I${i}`;
      const us = i % 4 === 0;
      instruments.push(inst(id, days.map((d, k) => [d, 100 + ((k * (i + 3)) % 37)]), us ? "US" : "IN"));
      const base = { instrumentId: id, currency: us ? ("USD" as const) : ("INR" as const), fxRateInr: us ? 83 : 1 };
      events.push(
        ev({ ...base, type: "buy", date: days[i * 3], qty: 10, price: 100 }),
        ev({ ...base, type: "buy", date: days[200 + i], qty: 5, price: 110 }),
        ev({ ...base, type: "split", date: days[400], exDate: days[399], qty: 15, ratio: { num: 2, den: 1 } }),
        ev({ ...base, type: "sell", date: days[500 + i], qty: 12, price: 60 }),
        ev({ ...base, type: "buy", date: days[600 + i], qty: 4, price: 70 }),
      );
    }
    const fx = days.map((d, k) => ({ date: d, usdInr: 82 + (k % 5) * 0.1 }));
    const t0 = performance.now();
    const v = buildHistory({ instruments, events, supersessions: [], actions: [], fx, today: "2026-11-11" }, owner, "all");
    const ms = performance.now() - t0;
    expect(pointsOf(v).length).toBe(days.length);
    expect(ms).toBeLessThan(200);
  });
});
