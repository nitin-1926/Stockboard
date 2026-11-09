import { describe, expect, it } from "vitest";
import { ev } from "./__fixtures__/ev";
import { replay } from "./lots";
import { planSupersession } from "./supersede";
import type { LedgerEvent } from "./types";

const D = "2026-11-10";
const opening = ev({ id: "open", type: "opening", source: "opening", date: "2026-11-09", qty: 10, price: 100 });
const inferred = ev({
  id: "inf",
  type: "buy",
  source: "inferred",
  date: D,
  executedAt: `${D}T15:45:00+05:30`,
  qty: 5,
  price: 130,
  approximate: true,
  sourceRef: "inferred:INFY:r1:r2",
});
const fill = (id: string, qty: number, at = `${D}T10:00:00+05:30`) =>
  ev({ id, sourceRef: `fill:${id}`, type: "buy", date: at.slice(0, 10), executedAt: at, qty, price: 128 });

describe("planSupersession: fills vs inferred", () => {
  it("a fill arriving after an inference supersedes it and totals reconcile", () => {
    const f = fill("t1", 5);
    const plan = planSupersession([opening, inferred], [f]);
    expect(plan.supersessions).toEqual([{ supersededId: "inf", supersedingId: "t1" }]);
    expect(plan.remainders).toEqual([]);
    expect(plan.refRemap.get("inf")).toEqual(["t1"]);
    const r = replay([opening, inferred, f], plan.supersessions);
    expect(r.positions.INFY.qty).toBe(15);
    expect(r.openLots.map((l) => l.eventId)).toEqual(["open", "t1"]);
  });

  it("partial fills across days: one inferred → many fills (link table)", () => {
    const a = fill("t1", 2, "2026-11-09T11:00:00+05:30");
    const b = fill("t2", 3);
    const plan = planSupersession([opening, inferred], [a, b]);
    expect(plan.supersessions).toEqual([
      { supersededId: "inf", supersedingId: "t1" },
      { supersededId: "inf", supersedingId: "t2" },
    ]);
    expect(plan.refRemap.get("inf")).toEqual(["t1", "t2"]);
  });

  it("fills short of the inferred qty leave an approximate remainder so totals still reconcile", () => {
    const f = fill("t1", 3);
    const plan = planSupersession([opening, inferred], [f]);
    expect(plan.remainders).toEqual([
      expect.objectContaining({ qty: 2, price: 130, source: "inferred", sourceRef: "inferred:INFY:r1:r2:rem" }),
    ]);
    expect(replay([opening, inferred, f, ...plan.remainders], plan.supersessions).positions.INFY.qty).toBe(15);
  });

  it("a fill executed after the inferred snapshot does not cover it", () => {
    const plan = planSupersession([opening, inferred], [fill("t1", 5, "2026-11-11T10:00:00+05:30")]);
    expect(plan.supersessions).toEqual([]);
  });

  it("re-planning with prior supersessions is a no-op", () => {
    const f = fill("t1", 5);
    const first = planSupersession([opening, inferred], [f]);
    expect(planSupersession([opening, inferred, f], [], first.supersessions).supersessions).toEqual([]);
  });
});

describe("planSupersession: CSV / US history ranges", () => {
  const csv = (id: string, type: "buy" | "sell", date: string, qty: number) =>
    ev({ id, sourceRef: `csv:${id}`, source: "csv", type, date, qty, price: 100 });

  it("supersedes inferred events inside the CSV date range only", () => {
    const inRange = ev({ id: "i1", source: "inferred", type: "buy", date: "2025-03-10", qty: 5, price: 99 });
    const outside = ev({ id: "i2", source: "inferred", type: "buy", date: "2025-09-10", qty: 5, price: 99 });
    const split = ev({ id: "sp", source: "inferred", type: "split", date: "2025-03-15", qty: 5, ratio: { num: 2, den: 1 } });
    const plan = planSupersession([inRange, outside, split], [csv("c1", "buy", "2025-03-08", 5), csv("c2", "sell", "2025-04-01", 2)]);
    expect(plan.supersessions).toEqual([{ supersededId: "i1", supersedingId: "c1" }]);
  });

  it("one opening → three CSV buys: every buy inherits the opening's refs", () => {
    const open = ev({ id: "open", type: "opening", source: "opening", date: "2026-11-01", qty: 30, price: 100 });
    const buys = [csv("c1", "buy", "2023-01-05", 10), csv("c2", "buy", "2024-01-05", 10), csv("c3", "buy", "2025-01-05", 10)];
    const plan = planSupersession([open], buys);
    expect(plan.supersessions).toHaveLength(3);
    expect(plan.refRemap.get("open")).toEqual(["c1", "c2", "c3"]);
  });

  it("an opening is kept when the CSV only has trades after it", () => {
    const open = ev({ id: "open", type: "opening", source: "opening", date: "2024-01-01", qty: 30, price: 100 });
    expect(planSupersession([open], [csv("c1", "buy", "2025-01-05", 10)]).supersessions).toEqual([]);
  });

  it("US history supersedes a US opening the same way", () => {
    const open = ev({ id: "open", instrumentId: "AAPL", currency: "USD", type: "opening", source: "opening", date: "2026-11-01", qty: 2, price: 150 });
    const us = ev({ id: "u1", instrumentId: "AAPL", currency: "USD", source: "us_history", type: "buy", date: "2025-03-07", qty: 2, price: 170 });
    expect(planSupersession([open], [us]).refRemap.get("open")).toEqual(["u1"]);
  });

  it("a CSV row and a fill for the same trade id: the CSV wins, in either arrival order", () => {
    const f = ev({ id: "f", sourceRef: "fill:123", type: "buy", date: D, qty: 5, price: 128 });
    const c = ev({ id: "c", sourceRef: "csv:123", source: "csv", type: "buy", date: D, qty: 5, price: 128 });
    expect(planSupersession([f], [c]).supersessions).toEqual([{ supersededId: "f", supersedingId: "c" }]);
    expect(planSupersession([c], [f]).supersessions).toEqual([{ supersededId: "f", supersedingId: "c" }]);
  });
});

describe("planSupersession: manual corrections", () => {
  it("a manual event replaces same-type events on the same date for the instrument", () => {
    const f = ev({ id: "f", type: "buy", date: "2025-01-10", qty: 5, price: 128 });
    const other = ev({ id: "o", type: "sell", date: "2025-01-10", qty: 1, price: 128 });
    const m = ev({ id: "m", source: "manual", type: "buy", date: "2025-01-10", qty: 6, price: 127 });
    const plan = planSupersession([f, other], [m]);
    expect(plan.supersessions).toEqual([{ supersededId: "f", supersedingId: "m" }]);
    expect(plan.refRemap.get("f")).toEqual(["m"]);
  });
});

describe("planSupersession: authoritative data after a manual correction of an inferred event", () => {
  const at = `${D}T15:45:00+05:30`;
  const infSell = ev({ id: "infS", type: "sell", source: "inferred", date: D, executedAt: at, qty: 5, price: 130, approximate: true });
  const fix = (of: LedgerEvent, p: Partial<LedgerEvent> = {}) =>
    ev({ ...of, id: `manual:${of.id}`, sourceRef: `manual:${of.id}`, source: "manual", approximate: false, ...p });
  const link = (a: LedgerEvent, b: LedgerEvent) => ({ supersededId: a.id, supersedingId: b.id });
  const sellFill = (id: string, qty: number, when = `${D}T10:00:00+05:30`) =>
    ev({ id, sourceRef: `fill:${id}`, type: "sell", date: when.slice(0, 10), executedAt: when, qty, price: 134 });

  it("a fill supersedes the manual head, not the inferred event, and replay doesn't double count", () => {
    const m = fix(infSell, { price: 135 });
    const prior = [link(infSell, m)];
    const f = sellFill("s1", 5);
    const plan = planSupersession([opening, infSell, m], [f], prior);
    expect(plan.supersessions).toEqual([{ supersededId: m.id, supersedingId: "s1" }]);
    const r = replay([opening, infSell, m, f], [...prior, ...plan.supersessions]);
    expect(r.positions.INFY.qty).toBe(5);
    expect(r.anomalies).toEqual([]);
    // Idempotent: re-planning with the new links is a no-op.
    expect(planSupersession([opening, infSell, m, f], [], [...prior, ...plan.supersessions]).supersessions).toEqual([]);
  });

  it("a corrected inferred buy hands its refs to the fill", () => {
    const m = fix(inferred, { price: 129 });
    const plan = planSupersession([opening, inferred, m], [fill("t1", 5)], [link(inferred, m)]);
    expect(plan.supersessions).toEqual([{ supersededId: m.id, supersedingId: "t1" }]);
    expect(plan.refRemap.get(m.id)).toEqual(["t1"]);
  });

  it("matching is anchored on the inferred snapshot, so a moved date still matches; a chain of corrections resolves to its head", () => {
    const m1 = fix(infSell, { date: "2026-11-07", executedAt: undefined });
    const m2 = fix(m1, { price: 140 });
    const plan = planSupersession([opening, infSell, m1, m2], [sellFill("s1", 5)], [link(infSell, m1), link(m1, m2)]);
    expect(plan.supersessions).toEqual([{ supersededId: m2.id, supersedingId: "s1" }]);
  });

  it("a Console CSV row in range supersedes the manual head", () => {
    const m = fix(infSell, { price: 135 });
    const c = ev({ id: "c1", sourceRef: "csv:c1", source: "csv", type: "sell", date: D, qty: 5, price: 133 });
    const plan = planSupersession([opening, infSell, m], [c], [link(infSell, m)]);
    expect(plan.supersessions).toEqual([{ supersededId: m.id, supersedingId: "c1" }]);
  });

  it("a partial fill leaves a remainder at the owner's price", () => {
    const m = fix(infSell, { price: 135 });
    const plan = planSupersession([opening, infSell, m], [sellFill("s1", 2)], [link(infSell, m)]);
    expect(plan.remainders).toEqual([expect.objectContaining({ qty: 3, price: 135, source: "inferred", approximate: true, sourceRef: `${m.sourceRef}:rem` })]);
    expect(plan.supersessions).toEqual([
      { supersededId: m.id, supersedingId: "s1" },
      { supersededId: m.id, supersedingId: `${m.sourceRef}:rem` },
    ]);
  });

  it("the Console row for a corrected fill's trade id supersedes the correction chain's head", () => {
    const f0 = sellFill("T1", 5);
    const m1 = fix(f0, { price: 135 });
    const m2 = fix(m1, { date: "2026-11-09" });
    const prior = [link(f0, m1), link(m1, m2)];
    const c = ev({ id: "csv:T1", source: "csv", type: "sell", date: D, qty: 5, price: 134 });
    const plan = planSupersession([opening, f0, m1, m2], [c], prior);
    expect(plan.supersessions).toEqual([{ supersededId: m2.id, supersedingId: c.id }]);
    const links = [...prior, ...plan.supersessions];
    const r = replay([opening, f0, m1, m2, c], links);
    expect(r.positions.INFY.qty).toBe(5);
    expect(r.anomalies).toEqual([]);
    expect(planSupersession([opening, f0, m1, m2, c], [], links).supersessions).toEqual([]);
  });

  it("a corrected fill buy hands its refs to its Console row", () => {
    const f0 = fill("T2", 5);
    const m = fix(f0, { price: 127 });
    const c = ev({ id: "csv:T2", source: "csv", type: "buy", date: D, qty: 5, price: 128 });
    expect(planSupersession([f0, m], [c], [link(f0, m)]).refRemap.get(m.id)).toEqual([c.id]);
  });

  it("a manual correction of a fill keeps current precedence: imports and other fills don't replace it", () => {
    const f0 = sellFill("s0", 5);
    const m = fix(f0, { price: 135 });
    const c = ev({ id: "c1", sourceRef: "csv:c9", source: "csv", type: "sell", date: D, qty: 5, price: 133 });
    expect(planSupersession([opening, f0, m], [c, sellFill("s2", 5)], [link(f0, m)]).supersessions).toEqual([]);
  });
});
