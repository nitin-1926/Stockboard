import { describe, expect, it } from "vitest";
import { type DueEntry, type DueTarget, dueReviews } from "./due-reviews";

// Pure: "Due for review" on the Overview. Today is 12 Nov 2026 in India.
const now = new Date("2026-11-12T08:00:00Z");
const target = (o: Partial<DueTarget> = {}): DueTarget => ({
  id: "t1",
  instrumentId: "i1",
  symbol: "INFY",
  currency: "INR",
  kind: "target",
  price: 1800,
  status: "expired",
  deadline: "2026-11-11",
  resolvedAt: "2026-11-11",
  missPct: -0.0533,
  ...o,
});
const entry = (o: Partial<DueEntry>): DueEntry => ({
  subjectType: "buy_event",
  subjectId: "b1",
  instrumentId: "i1",
  kind: "thesis",
  createdAt: new Date("2026-10-01T06:00:00Z"),
  ...o,
});
const thesis = entry({});

describe("dueReviews", () => {
  it("a target that expired yesterday, with a thesis on the buy and no review → due, with outcome and miss %", () => {
    expect(dueReviews([target()], [thesis], now)).toEqual([
      {
        targetId: "t1",
        instrumentId: "i1",
        symbol: "INFY",
        currency: "INR",
        kind: "target",
        price: 1800,
        outcome: "expired",
        missPct: -0.0533,
        resolvedOn: "2026-11-11",
        daysSince: 1,
      },
    ]);
  });

  it("a review on the target written after it resolved → not due", () => {
    const review = entry({ subjectType: "target", subjectId: "t1", kind: "review", createdAt: new Date("2026-11-12T07:00:00Z") });
    expect(dueReviews([target()], [thesis, review], now)).toEqual([]);
    // A review on another target, or a note, doesn't count.
    const other = entry({ subjectType: "target", subjectId: "t2", kind: "review", createdAt: new Date("2026-11-12T07:00:00Z") });
    const note = entry({ subjectType: "target", subjectId: "t1", kind: "note", createdAt: new Date("2026-11-12T07:00:00Z") });
    expect(dueReviews([target()], [thesis, other, note], now)).toHaveLength(1);
    // A review written before it resolved is about the open call, not the outcome.
    const early = entry({ subjectType: "target", subjectId: "t1", kind: "review", createdAt: new Date("2026-11-05T07:00:00Z") });
    expect(dueReviews([target()], [thesis, early], now)).toHaveLength(1);
  });

  it("resolved 8 days ago → not due; 7 days ago → still due", () => {
    expect(dueReviews([target({ resolvedAt: "2026-11-04", deadline: "2026-11-04" })], [thesis], now)).toEqual([]);
    expect(dueReviews([target({ resolvedAt: "2026-11-05", deadline: "2026-11-05" })], [thesis], now)).toHaveLength(1);
  });

  it("no thesis → not due (a thesis on another instrument or a plain note doesn't count)", () => {
    expect(dueReviews([target()], [], now)).toEqual([]);
    expect(dueReviews([target()], [entry({ instrumentId: "i2" }), entry({ kind: "note" })], now)).toEqual([]);
  });

  it("thesis on the target itself or on the watch item counts", () => {
    expect(dueReviews([target()], [entry({ subjectType: "target", subjectId: "t1" })], now)).toHaveLength(1);
    expect(dueReviews([target()], [entry({ subjectType: "watch_item", subjectId: "w1" })], now)).toHaveLength(1);
    // A thesis on a different target of the same symbol is about that call.
    expect(dueReviews([target()], [entry({ subjectType: "target", subjectId: "t9" })], now)).toEqual([]);
  });

  it("hit carries no miss %; a pending target past its deadline reads as expired; cancelled and open ones never show", () => {
    const hit = target({ id: "h", status: "hit", resolvedAt: "2026-11-10", deadline: null, missPct: null });
    const late = target({ id: "p", status: "pending", resolvedAt: null, deadline: "2026-11-09", missPct: null });
    const open = target({ id: "o", status: "pending", resolvedAt: null, deadline: "2026-11-20" });
    const cancelled = target({ id: "c", status: "cancelled", resolvedAt: "2026-11-11" });
    const r = dueReviews([late, hit, open, cancelled], [thesis], now);
    expect(r.map((d) => [d.targetId, d.outcome, d.missPct, d.daysSince])).toEqual([
      ["h", "hit", null, 2],
      ["p", "expired", null, 3],
    ]);
  });
});
