import { describe, expect, it } from "vitest";
import type { Actor } from "@/lib/auth/access";
import { buildTargetsView, nearestMarks, type TargetInput, type TargetsInputs } from "./targets";

const OWNER = "owner@x.com";
const owner: Actor = { kind: "owner", email: OWNER, hideAmounts: false, via: "session" };
const contributor: Actor = { kind: "contributor", email: "c@x.com", hideAmounts: false, via: "session" };
const linkViewer: Actor = { kind: "viewer", hideAmounts: true, via: "share-link" };

const t = (over: Partial<TargetInput>): TargetInput => ({
  id: "t1",
  instrumentId: "i1",
  symbol: "TCS",
  name: "Tata Consultancy",
  exchange: "NSE",
  market: "IN",
  currency: "INR",
  kind: "target",
  price: 1200,
  inputMode: "abs",
  pctValue: null,
  deadline: null,
  setBy: OWNER,
  priceAtSet: 1000,
  setAt: new Date("2026-11-02T05:00:00Z"),
  status: "pending",
  resolvedAt: null,
  resolvedPrice: null,
  bestPrice: null,
  missPct: null,
  replacedBy: null,
  note: null,
  ltp: { price: 1100, asOf: new Date("2026-11-11T09:00:00Z") },
  actions: [],
  ...over,
});

const inputs = (targets: TargetInput[]): TargetsInputs => ({
  targets,
  instruments: [{ id: "i1", symbol: "TCS", name: "Tata Consultancy", exchange: "NSE", currency: "INR", price: 1100 }],
  ownerEmail: OWNER,
  now: new Date("2026-11-11T10:00:00Z"),
});

const sample = [
  t({ id: "a", deadline: "2026-11-21" }),
  t({ id: "b", kind: "stop", price: 1050, setBy: "c@x.com" }),
  t({ id: "c", status: "hit", resolvedAt: "2026-11-09", resolvedPrice: 1210, setBy: "c@x.com" }),
  t({ id: "d", status: "expired", resolvedAt: "2026-11-05", missPct: -0.05, setBy: "m@x.com" }),
  t({ id: "e", status: "cancelled", resolvedAt: "2026-11-10", replacedBy: "a" }),
];

describe("buildTargetsView", () => {
  it("splits active and history, with live distance and days left", () => {
    const v = buildTargetsView(inputs(sample), owner);
    expect(v.active.map((r) => r.id)).toEqual(["b", "a"]); // nearest first: stop −4.5% before target +9.1%
    const a = v.active.find((r) => r.id === "a")!;
    expect(a.distancePct).toBeCloseTo(1200 / 1100 - 1, 9);
    expect(a.daysLeft).toBe(10);
    expect(a.setOn).toBe("2026-11-02");
    expect(v.history.map((r) => r.id)).toEqual(["e", "c", "d"]);
    const c = v.history.find((r) => r.id === "c")!;
    expect(c).toMatchObject({ daysToResolve: 7, distancePct: null, canEdit: false });
    expect(v.history.find((r) => r.id === "e")).toMatchObject({ replaced: true, daysToResolve: null });
  });

  it("canEdit follows the resource-owner rule; only the owner re-evaluates", () => {
    const o = buildTargetsView(inputs(sample), owner);
    expect(o.active.every((r) => r.canEdit)).toBe(true);
    expect(o).toMatchObject({ canCreate: true, canReevaluate: true });
    const c = buildTargetsView(inputs(sample), contributor);
    expect(Object.fromEntries(c.active.map((r) => [r.id, r.canEdit]))).toEqual({ a: false, b: true });
    expect(c).toMatchObject({ canCreate: true, canReevaluate: false });
  });

  it("share-link viewers get no emails, no controls and the same prices and percentages", () => {
    const v = buildTargetsView(inputs(sample), linkViewer);
    const json = JSON.stringify(v);
    expect(json).not.toMatch(/@x\.com/);
    expect(v).toMatchObject({ canCreate: false, canReevaluate: false, instruments: [] });
    expect([...v.active, ...v.history].every((r) => !r.canEdit)).toBe(true);
    expect(v.active.find((r) => r.id === "a")!.setBy).toBe("Owner");
    expect(v.scorecard.map((s) => s.label)).toEqual(["Contributor 1", "Contributor 2", "Owner"]);
    // Hide-amounts redaction strips nothing here: a target has no amount fields.
    const full = buildTargetsView(inputs(sample), { ...owner, hideAmounts: true });
    expect(full.active.map((r) => [r.price, r.distancePct])).toEqual(v.active.map((r) => [r.price, r.distancePct]));
  });

  it("scorecard per set_by, emails shown to session users", () => {
    const v = buildTargetsView(inputs(sample), contributor);
    const c = v.scorecard.find((s) => s.label === "c@x.com")!;
    expect(c.target).toMatchObject({ total: 1, resolved: 1, hitRate: 1, medianDaysToHit: 7 });
    expect(c.stop).toMatchObject({ total: 1, open: 1 });
    expect(v.scorecard.find((s) => s.label === "m@x.com")!.target).toMatchObject({ hitRate: 0, avgMissPct: -0.05 });
  });
});

describe("effective level after a split or bonus", () => {
  // Set 2026-11-02 at a raw 1500; today's price 780.
  const at = (actions: TargetInput["actions"]) =>
    buildTargetsView(inputs([t({ price: 1500, ltp: { price: 780, asOf: new Date("2026-11-11T09:00:00Z") }, actions })]), owner).active[0];

  it("a 2:1 split after the set date halves the level: 750, −3.85% to go (not +92%)", () => {
    const r = at([{ exDate: "2026-11-05", ratio: 2 }]);
    expect(r).toMatchObject({ price: 750, setPrice: 1500 });
    expect(r.distancePct).toBeCloseTo(750 / 780 - 1, 9);
    // Holdings / watchlist marks are built from the same rows.
    expect(nearestMarks(buildTargetsView(inputs([t({ price: 1500, actions: [{ exDate: "2026-11-05", ratio: 2 }] })]), owner).active).get("i1")!.target).toBe(750);
  });

  it("a 1:1 bonus (stored 2:1) reads the same", () => {
    expect(at([{ exDate: "2026-11-05", ratio: 2 }])).toMatchObject({ price: 750, setPrice: 1500 });
  });

  it("no action after the set date leaves the level unchanged", () => {
    for (const actions of [[], [{ exDate: "2026-10-01", ratio: 2 }], [{ exDate: "2026-11-02", ratio: 2 }], [{ exDate: "2026-11-20", ratio: 2 }]]) {
      const r = at(actions);
      expect(r).toMatchObject({ price: 1500, setPrice: null });
      expect(r.distancePct).toBeCloseTo(1500 / 780 - 1, 9);
    }
  });

  it("several actions compound", () => {
    const r = at([
      { exDate: "2026-11-04", ratio: 2 },
      { exDate: "2026-11-06", ratio: 2 },
      { exDate: "2026-10-01", ratio: 5 },
    ]);
    expect(r).toMatchObject({ price: 375, setPrice: 1500 });
    expect(r.distancePct).toBeCloseTo(375 / 780 - 1, 9);
  });
});

describe("nearestMarks", () => {
  it("lowest target and highest stop per instrument", () => {
    const m = nearestMarks([
      { instrumentId: "i1", kind: "target", price: 1300 },
      { instrumentId: "i1", kind: "target", price: 1200 },
      { instrumentId: "i1", kind: "stop", price: 900 },
      { instrumentId: "i1", kind: "stop", price: 950 },
      { instrumentId: "i2", kind: "stop", price: 50 },
    ]);
    expect(m.get("i1")).toEqual({ target: 1200, stop: 950, count: 4 });
    expect(m.get("i2")).toEqual({ target: null, stop: 50, count: 1 });
  });
});
