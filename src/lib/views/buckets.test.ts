import { describe, expect, it } from "vitest";
import type { Actor } from "@/lib/auth/access";
import type { LedgerLot } from "@/lib/ledger/types";
import { PAPER_NOTIONAL_INR } from "@/lib/returns/aggregate";
import {
  bonusSlices,
  BUCKET_REAL_POLICY,
  type BucketsInputs,
  buildBucketDetail,
  buildBucketsView,
  type InstrumentInput,
  MEMBER_POLICY,
  type MemberInput,
} from "./buckets";

const owner: Actor = { kind: "owner", email: "owner@x.com", hideAmounts: false, via: "session" };
const contributor: Actor = { kind: "contributor", email: "c@x.com", hideAmounts: false, via: "session" };
const hidden: Actor = { kind: "viewer", hideAmounts: true, via: "share-link" };
const NOW = new Date("2026-06-01T09:00:00Z"); // 14:30 IST → asOf 2026-06-01

const lot = (eventId: string, instrumentId: string, qty: number, cost: number, openDate: string, closed: LedgerLot["closed"] = []): LedgerLot => ({
  eventId,
  instrumentId,
  market: "IN",
  currency: "INR",
  qty,
  costPerShare: cost,
  openDate,
  fxRateAtOpen: 1,
  closed,
});
const inst = (id: string, price: number | null, over: Partial<InstrumentInput> = {}): InstrumentInput => ({
  id,
  symbol: id,
  name: `${id} Ltd`,
  market: "IN",
  currency: "INR",
  price,
  dividends: [],
  splits: [],
  ...over,
});
const buy = (id: string, l: LedgerLot, by = "owner@x.com"): MemberInput => ({
  kind: "buy_event",
  id,
  bucketId: "b1",
  addedBy: by,
  instrumentId: l.instrumentId,
  eventId: l.eventId,
  lot: l,
  approximate: false,
});
const paper = (id: string, instrumentId: string, priceAtAdd: number | null, by = "owner@x.com"): MemberInput => ({
  kind: "watch_item",
  id,
  bucketId: "b1",
  addedBy: by,
  instrumentId,
  watchItemId: `w-${id}`,
  priceAtAdd,
  watchAddedAt: new Date("2026-01-02T05:00:00Z"),
});

// Real: A bought 10 @100 on Jan 2, now 120 (open). S bought 10 @100, all sold @150 (realized +500).
// Paper: P1 100 → 130 (+30%), P2 10,000 → 9,000 (−10%): equal-weighted mean +10%.
const base = (over: Partial<BucketsInputs> = {}): BucketsInputs => ({
  buckets: [{ id: "b1", name: "Manager picks", description: null, color: "chart-1", createdBy: "owner@x.com" }],
  members: [
    buy("m1", lot("eA", "A", 10, 100, "2026-01-02")),
    buy("m2", lot("eS", "S", 10, 100, "2026-01-02", [{ qty: 10, date: "2026-03-02", pricePerShare: 150, fxRate: 1 }]), "c@x.com"),
    paper("m3", "P1", 100),
    paper("m4", "P2", 10_000),
  ],
  instruments: { A: inst("A", 120), S: inst("S", 80), P1: inst("P1", 130), P2: inst("P2", 9_000) },
  fx: null,
  fxSeries: {},
  benchmarks: { IN: null, US: null },
  withholding: { IN: 0.1, US: 0.25 },
  ownerEmail: "owner@x.com",
  now: NOW,
  ...over,
});

describe("buildBucketsView", () => {
  it("honesty: a fully sold member stays in the bucket and its realized P&L counts", () => {
    const [b] = buildBucketsView(base(), owner).buckets;
    expect(b.real.count).toBe(2);
    expect(b.real.sold).toBe(1);
    expect(b.real.realizedInr).toBeCloseTo(500);
    expect(b.real.unrealizedInr).toBeCloseTo(200);
    expect(b.real.totalReturnInr).toBeCloseTo(700);
    expect(b.real.costInr).toBeCloseTo(1000); // only what is still open
    expect(b.real.returnPct).toBeCloseTo(2700 / 2000 - 1, 9); // money out (1500 sold + 1200 value) / money in
    expect(b.real.realizedPct).toBeCloseTo(0.25, 9);
    expect(b.real.useAbsolute).toBe(true); // under a year → absolute, no XIRR
    expect(b.real.xirr).toBeNull();
  });

  it("paper members: equal-weighted, separate, and never in money totals", () => {
    const [b] = buildBucketsView(base(), owner).buckets;
    expect(b.paper.count).toBe(2);
    expect(b.paper.returnPct).toBeCloseTo(0.1, 9); // (+30% − 10%) / 2; price-weighted would be ≈ −9.6%
    expect(b.real.valueInr).toBeCloseTo(1200);
    const solo = buildBucketsView(base({ members: base().members.filter((m) => m.kind === "buy_event") }), owner).buckets[0];
    expect(solo.real).toEqual(b.real);
  });

  it("combined % = real flows plus paper at the fixed notional", () => {
    const [b] = buildBucketsView(base(), owner).buckets;
    const n = PAPER_NOTIONAL_INR;
    expect(b.combined.returnPct).toBeCloseTo((2700 + 2 * n * 1.1) / (2000 + 2 * n) - 1, 9);
  });

  it("paper items with no price at add are skipped and counted", () => {
    const [b] = buildBucketsView(base({ members: [paper("p", "P1", null)] }), owner).buckets;
    expect(b.paper).toMatchObject({ count: 0, skipped: 1, returnPct: null });
    const d = buildBucketDetail(base({ members: [paper("p", "P1", null)] }), owner, "b1")!;
    expect(d.paperMembers[0].skipped).toBe("no price at add");
  });

  it("an open member without a price is left out of totals and flagged", () => {
    const [b] = buildBucketsView(base({ instruments: { ...base().instruments, A: inst("A", null) } }), owner).buckets;
    expect(b.real.unpriced).toBe(1);
    expect(b.real.count).toBe(1);
    expect(b.real.realizedInr).toBeCloseTo(500);
  });

  it("hide-amounts: no money fields on cards, member rows or the chart scale; % stay", () => {
    const view = buildBucketsView(base(), hidden);
    const card = view.buckets[0];
    for (const k of BUCKET_REAL_POLICY) expect(card.real).not.toHaveProperty(k);
    expect(card.real.returnPct).toBeCloseTo(0.35, 9);
    expect(card.real.realizedPct).toBeCloseTo(0.25, 9);
    expect(card.createdBy).toBe("Owner"); // no emails for share-link viewers

    const d = buildBucketDetail(base(), hidden, "b1")!;
    for (const row of d.realMembers) for (const k of MEMBER_POLICY) expect(row).not.toHaveProperty(k);
    expect(d.realMembers.map((r) => r.addedBy).sort()).toEqual(["Contributor", "Owner"]);
    expect(d.chart?.normalized).toBe(true);
    // Per ₹100 put in: the last point is today's value 1200 over 2000 in.
    expect(d.chart!.points.at(-1)!.portfolio).toBeCloseTo(60, 9);
    expect(JSON.stringify(d)).not.toContain("owner@x.com");
  });

  it("benchmark pending when no index history is stored; a number once it is", () => {
    const [pending] = buildBucketsView(base(), owner).buckets;
    expect(pending.alpha).toEqual([{ market: "IN", label: "Nifty 50", status: "pending" }]);
    expect(buildBucketDetail(base(), owner, "b1")!.chart?.benchmarkPending).toBe(true);

    // Index history that starts after the first buy is still pending.
    const late = { IN: { closes: { "2026-02-01": 100 } }, US: null };
    expect(buildBucketsView(base({ benchmarks: late }), owner).buckets[0].alpha[0].status).toBe("pending");

    // Flat index → benchmark returns 0 on the same flows, alpha = the bucket's own absolute return.
    const flat = { IN: { closes: { "2025-12-31": 100, "2026-05-29": 100 } }, US: null };
    const [b] = buildBucketsView(base({ benchmarks: flat }), owner).buckets;
    expect(b.alpha[0]).toMatchObject({ status: "ok", annualized: false, benchmarkReturn: expect.closeTo(0, 9) });
    expect(b.alpha[0].status === "ok" && b.alpha[0].alpha).toBeCloseTo(0.35, 9);
    const chart = buildBucketDetail(base({ benchmarks: flat }), owner, "b1")!.chart!;
    expect(chart.benchmarkPending).toBe(false);
    expect(chart.points[0].benchmark).toBeCloseTo(2000, 6); // both buys, index flat
    expect(chart.points.at(-1)!.benchmark).toBeCloseTo(500, 6); // 2000 in, 1500 taken out by the sale
  });

  it("dividends: net of withholding, per-share scaled to the post-split lot basis", () => {
    // 10 shares bought Jan 2; a 2:1 split on Apr 1 makes the lot 20. A raw ₹4/share dividend
    // on Mar 1 was paid on 10 pre-split shares: ₹40 gross, ₹36 net at 10% TDS.
    const members = [buy("m1", lot("eA", "A", 20, 50, "2026-01-02"))];
    const A = inst("A", 60, { dividends: [{ exDate: "2026-03-01", perShareGross: 4, currency: "INR", fxRate: 1 }], splits: [{ exDate: "2026-04-01", ratio: 2 }] });
    const [b] = buildBucketsView(base({ members, instruments: { A } }), owner).buckets;
    expect(b.real.dividendsNetInr).toBeCloseTo(36);
    expect(b.real.totalReturnInr).toBeCloseTo(200 + 36);
  });

  it("bonus: a member gets its pro-rata slice of later bonus lots (with their sales), chained", () => {
    // Member M 10 + outside lot O 30. 1:1 bonus ex Mar 2 → B1 40 (allotted Mar 5, 8 sold May 1 @150).
    // Second 1:1 bonus ex Apr 1 on 80 held → B2 80. M held 10 of 40, then 20 (10 + its B1 slice) of 80.
    const M = lot("eM", "A", 10, 100, "2026-01-02");
    const lots = [
      M,
      lot("eO", "A", 30, 120, "2026-02-01"),
      lot("eB1", "A", 40, 0, "2026-03-05", [{ qty: 8, date: "2026-05-01", pricePerShare: 150, fxRate: 1 }]),
      lot("eB2", "A", 80, 0, "2026-04-05"),
    ];
    const slices = bonusSlices(M, lots, [
      { eventId: "eB2", exDate: "2026-04-01" },
      { eventId: "eB1", exDate: "2026-03-02" },
    ]);
    expect(slices.map((l) => [l.eventId, l.qty, l.costPerShare, l.closed.map((c) => c.qty)])).toEqual([
      ["eB1", 10, 0, [2]],
      ["eB2", 20, 0, []],
    ]);

    const members: MemberInput[] = [{ ...(buy("m1", M) as Extract<MemberInput, { kind: "buy_event" }>), bonusLots: slices }];
    const [b] = buildBucketsView(base({ members, instruments: { A: inst("A", 120) } }), owner).buckets;
    expect(b.real.costInr).toBeCloseTo(1000); // bonus shares are free
    expect(b.real.valueInr).toBeCloseTo((10 + 8 + 20) * 120);
    expect(b.real.realizedInr).toBeCloseTo(2 * 150);
    expect(b.real.totalReturnInr).toBeCloseTo(38 * 120 - 1000 + 300);
    const row = buildBucketDetail(base({ members, instruments: { A: inst("A", 120) } }), owner, "b1")!.realMembers[0];
    expect(row).toMatchObject({ qty: 10, openQty: 38, status: "partly sold" });
  });

  it("controls follow the role: contributor edits/removes only their own, never archives", () => {
    const d = buildBucketDetail(base(), contributor, "b1")!;
    expect(d.canEdit).toBe(false);
    expect(d.canArchive).toBe(false);
    expect(d.canAddMember).toBe(true);
    expect(Object.fromEntries(d.realMembers.map((r) => [r.id, r.canRemove]))).toEqual({ m1: false, m2: true });
    expect(buildBucketsView(base(), contributor).canCreate).toBe(true);
    const v = buildBucketDetail(base(), hidden, "b1")!;
    expect([v.canEdit, v.canArchive, v.canAddMember, buildBucketsView(base(), hidden).canCreate]).toEqual([false, false, false, false]);
    expect(v.options).toEqual({ lots: [], watch: [] });
  });

  it("empty bucket → zero counts, null returns, no chart", () => {
    const [b] = buildBucketsView(base({ members: [] }), owner).buckets;
    expect(b.real.count).toBe(0);
    expect(b.real.returnPct).toBeNull();
    expect(b.alpha).toEqual([]);
    expect(buildBucketDetail(base({ members: [] }), owner, "b1")!.chart).toBeNull();
  });
});
