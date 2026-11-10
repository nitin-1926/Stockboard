import { describe, expect, it } from "vitest";
import { type Bar, daysToResolve, type EvalTarget, evaluate, priceFromPct, upside, validateLevel } from "./evaluate";

const bar = (date: string, high: number | null, low: number | null, close: number): Bar => ({ date, high, low, close });
const target = (over: Partial<EvalTarget> = {}): EvalTarget => ({
  kind: "target",
  price: 1500,
  setOn: "2026-11-02",
  deadline: null,
  status: "pending",
  ...over,
});

describe("evaluate", () => {
  it("target 1500, a day's high reaches 1510 → hit on that day, with days to hit", () => {
    const bars = [bar("2026-11-03", 1460, 1440, 1450), bar("2026-11-09", 1510, 1470, 1490), bar("2026-11-10", 1530, 1500, 1520)];
    const r = evaluate(target(), bars, [], "2026-11-11");
    expect(r).toMatchObject({ status: "hit", resolvedAt: "2026-11-09", resolvedPrice: 1510, missPct: null });
    expect(daysToResolve("2026-11-02", r.resolvedAt)).toBe(7);
  });

  it("stop 900, a day's low touches 899 → stopped", () => {
    const r = evaluate(target({ kind: "stop", price: 900 }), [bar("2026-11-04", 960, 930, 940), bar("2026-11-05", 935, 899, 910)], [], "2026-11-11");
    expect(r).toMatchObject({ status: "stopped", resolvedAt: "2026-11-05", resolvedPrice: 899 });
  });

  it("deadline 2026-12-31, best 1420 before it → expired, miss ≈ −5.33%", () => {
    const bars = [bar("2026-11-20", 1400, 1350, 1390), bar("2026-12-15", 1420, 1380, 1410), bar("2026-12-31", 1415, 1390, 1400), bar("2027-01-04", 1600, 1500, 1580)];
    const t = target({ deadline: "2026-12-31" });
    expect(evaluate(t, bars, [], "2026-12-31").status).toBe("pending"); // not past the deadline yet
    const r = evaluate(t, bars, [], "2027-01-05");
    expect(r).toMatchObject({ status: "expired", resolvedAt: "2026-12-31", resolvedPrice: 1400, bestPrice: 1420 });
    expect(r.missPct).toBeCloseTo(-0.0533, 4); // the post-deadline 1600 bar is ignored
  });

  it("hit on the deadline day beats expiry", () => {
    const r = evaluate(target({ deadline: "2026-12-31" }), [bar("2026-12-31", 1505, 1450, 1480)], [], "2027-01-02");
    expect(r).toMatchObject({ status: "hit", resolvedAt: "2026-12-31" });
  });

  it("a 2:1 split after the target was set halves the threshold", () => {
    const splits = [{ exDate: "2026-11-10", ratio: 2 }];
    // 760 raw after the split = 1520 on the set basis → hit; 740 (=1480) would not be.
    expect(evaluate(target(), [bar("2026-11-10", 740, 700, 720)], splits, "2026-11-11").status).toBe("pending");
    const r = evaluate(target(), [bar("2026-11-10", 740, 700, 720), bar("2026-11-11", 760, 730, 750)], splits, "2026-11-11");
    expect(r).toMatchObject({ status: "hit", resolvedAt: "2026-11-11", resolvedPrice: 760, bestPrice: 1520 });
    // A split before the set date is already in the set-time price.
    expect(evaluate(target(), [bar("2026-11-11", 760, 730, 750)], [{ exDate: "2026-11-01", ratio: 2 }], "2026-11-11").status).toBe("pending");
  });

  it("uses the close when the high (or low) is missing", () => {
    expect(evaluate(target(), [bar("2026-11-05", null, null, 1500)], [], "2026-11-11").status).toBe("hit");
    expect(evaluate(target({ kind: "stop", price: 900 }), [bar("2026-11-05", null, null, 901)], [], "2026-11-11").status).toBe("pending");
  });

  it("ignores the set day's own bar and bars after asOf", () => {
    const bars = [bar("2026-11-02", 1600, 1400, 1450), bar("2026-11-12", 1600, 1500, 1550)];
    expect(evaluate(target(), bars, [], "2026-11-11")).toMatchObject({ status: "pending", bestPrice: null });
  });

  it("resolved and cancelled targets are immutable", () => {
    const resolved = target({ status: "hit", resolvedAt: "2026-11-05", resolvedPrice: 1505, bestPrice: 1505 });
    expect(evaluate(resolved, [bar("2026-11-06", 100, 50, 60)], [], "2026-12-01")).toEqual({
      status: "hit",
      resolvedAt: "2026-11-05",
      resolvedPrice: 1505,
      bestPrice: 1505,
      missPct: null,
    });
    expect(evaluate(target({ status: "cancelled", resolvedAt: "2026-11-03" }), [bar("2026-11-06", 2000, 1900, 1950)], [], "2026-12-01").status).toBe("cancelled");
  });

  it("stop expiry reports the lowest low as best and a positive miss", () => {
    const r = evaluate(target({ kind: "stop", price: 900, deadline: "2026-11-20" }), [bar("2026-11-10", 990, 945, 960)], [], "2026-11-21");
    expect(r).toMatchObject({ status: "expired", bestPrice: 945 });
    expect(r.missPct).toBeCloseTo(0.05, 6);
  });
});

describe("helpers", () => {
  it("% target +20% set at 1000 → 1200 (and a −10% stop → 900)", () => {
    expect(priceFromPct(1000, 0.2)).toBe(1200);
    expect(priceFromPct(1000, -0.1)).toBe(900);
    expect(priceFromPct(123.45, 0.1)).toBe(135.8);
  });

  it("upside is the distance from the current price", () => {
    expect(upside(1200, 1000)).toBeCloseTo(0.2, 9);
    expect(upside(900, 1000)).toBeCloseTo(-0.1, 9);
    expect(upside(900, null)).toBeNull();
  });

  it("a target must be above and a stop below the current price", () => {
    expect(validateLevel("target", 1100, 1000)).toBeNull();
    expect(validateLevel("target", 1000, 1000)).toMatch(/above/);
    expect(validateLevel("stop", 900, 1000)).toBeNull();
    expect(validateLevel("stop", 1001, 1000)).toMatch(/below/);
    expect(validateLevel("stop", 0, 1000)).toMatch(/above zero/);
  });
});
