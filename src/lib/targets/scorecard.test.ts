import { describe, expect, it } from "vitest";
import { type ScoreInput, scorecards } from "./scorecard";

const row = (over: Partial<ScoreInput>): ScoreInput => ({
  setBy: "m@x.com",
  kind: "target",
  status: "pending",
  setOn: "2026-01-01",
  resolvedAt: null,
  missPct: null,
  ...over,
});

describe("scorecards", () => {
  it("3 hit + 1 expired → 75% hit rate, median days to hit, average miss", () => {
    const [m] = scorecards([
      row({ status: "hit", resolvedAt: "2026-01-11" }), // 10 days
      row({ status: "hit", resolvedAt: "2026-01-31" }), // 30
      row({ status: "hit", resolvedAt: "2026-01-21" }), // 20
      row({ status: "expired", resolvedAt: "2026-03-31", missPct: -0.0533 }),
      row({ status: "pending" }),
      row({ status: "cancelled", resolvedAt: "2026-01-05" }),
    ]);
    expect(m.setBy).toBe("m@x.com");
    expect(m.target).toEqual({
      total: 5,
      resolved: 4,
      reached: 3,
      hitRate: 0.75,
      medianDaysToHit: 20,
      avgMissPct: -0.0533,
      open: 1,
      cancelled: 1,
    });
    expect(m.stop).toMatchObject({ total: 0, resolved: 0, hitRate: null, medianDaysToHit: null, avgMissPct: null });
  });

  it("scores stops separately and per set_by", () => {
    const cards = scorecards([
      row({ kind: "stop", status: "stopped", resolvedAt: "2026-01-05" }),
      row({ kind: "stop", status: "stopped", resolvedAt: "2026-01-09" }),
      row({ setBy: "o@x.com", status: "hit", resolvedAt: "2026-01-02" }),
    ]);
    expect(cards.map((c) => c.setBy)).toEqual(["m@x.com", "o@x.com"]);
    expect(cards[0].stop).toMatchObject({ total: 2, reached: 2, hitRate: 1, medianDaysToHit: 6 });
    expect(cards[0].target.total).toBe(0);
    expect(cards[1].target).toMatchObject({ hitRate: 1, medianDaysToHit: 1 });
  });
});
