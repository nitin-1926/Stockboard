import { describe, expect, it } from "vitest";
import { ev } from "./__fixtures__/ev";
import { matchCorporateAction, pendingFactor, unappliedActions } from "./corporate-actions";
import type { CorporateAction } from "./types";

const split = (exDate: string, num = 2, den = 1): CorporateAction => ({
  instrumentId: "INFY",
  exDate,
  ratio: { num, den },
  kind: "split",
});
const base = { ledgerQty: 10, ledgerCost: 1000, diffDate: "2026-11-10" };

describe("matchCorporateAction", () => {
  it("2:1 on the diff date with cost preserved → pure action", () => {
    const m = matchCorporateAction({ ...base, snapshotQty: 20, snapshotAvg: 50, actions: [split("2026-11-10")] });
    expect(m).toMatchObject({ kind: "action", remainder: 0, costPreserved: true });
  });

  it("matches an ex-date up to 14 calendar days before the diff (credit lag)", () => {
    const m = matchCorporateAction({ ...base, snapshotQty: 20, snapshotAvg: 50, actions: [split("2026-10-27")] });
    expect(m.kind).toBe("action");
  });

  it("ex-date outside the window → no candidate; cost preserved → unexplained", () => {
    const m = matchCorporateAction({ ...base, snapshotQty: 20, snapshotAvg: 50, actions: [split("2026-10-20")] });
    expect(m.kind).toBe("unexplained");
  });

  it("ex-date after the diff date is not a match", () => {
    const m = matchCorporateAction({ ...base, snapshotQty: 15, snapshotAvg: 110, actions: [split("2026-11-12")] });
    expect(m).toEqual({ kind: "none" });
  });

  it("within 0.5% of the ratio still matches", () => {
    const m = matchCorporateAction({ ...base, snapshotQty: 20.08, snapshotAvg: 1000 / 20.08, actions: [split("2026-11-10")] });
    expect(m).toMatchObject({ kind: "action", costPreserved: true });
  });

  it("qty beyond the ratio, cost not preserved → action plus remainder (split+buy)", () => {
    const m = matchCorporateAction({ ...base, snapshotQty: 25, snapshotAvg: 52, actions: [split("2026-11-10")] });
    expect(m).toMatchObject({ kind: "action", remainder: 5, costPreserved: false });
  });

  it("qty matches the ratio but cost differs → action, flagged via costPreserved", () => {
    const m = matchCorporateAction({ ...base, snapshotQty: 20, snapshotAvg: 60, actions: [split("2026-11-10")] });
    expect(m).toMatchObject({ kind: "action", remainder: 0, costPreserved: false });
  });

  it("qty between pre and post-split quantities → unexplained (ambiguous)", () => {
    const m = matchCorporateAction({ ...base, snapshotQty: 14, snapshotAvg: 90, actions: [split("2026-11-10")] });
    expect(m.kind).toBe("unexplained");
  });

  it("qty below the ledger with a split pending → not credited yet → none", () => {
    const m = matchCorporateAction({ ...base, snapshotQty: 8, snapshotAvg: 100, actions: [split("2026-11-10")] });
    expect(m).toEqual({ kind: "none" });
  });

  it("reverse split 1:2 is matched symmetrically", () => {
    const m = matchCorporateAction({ ...base, snapshotQty: 5, snapshotAvg: 200, actions: [split("2026-11-10", 1, 2)] });
    expect(m).toMatchObject({ kind: "action", remainder: 0, costPreserved: true });
  });

  it("ordinary buy with no action → none", () => {
    const m = matchCorporateAction({ ...base, snapshotQty: 15, snapshotAvg: 110, actions: [] });
    expect(m).toEqual({ kind: "none" });
  });
});

describe("unappliedActions / pendingFactor", () => {
  const opening = ev({ type: "opening", source: "opening", date: "2026-11-01", qty: 10, price: 100 });

  it("skips actions already in the ledger, before the ledger start, or for other instruments", () => {
    const applied = ev({ type: "split", source: "inferred", date: "2026-11-05", exDate: "2026-11-05", qty: 10, ratio: { num: 2, den: 1 } });
    const actions = [split("2026-10-01"), split("2026-11-05"), split("2026-11-09"), { ...split("2026-11-09"), instrumentId: "TCS" }];
    expect(unappliedActions("INFY", actions, [opening, applied])).toEqual([split("2026-11-09")]);
  });

  it("ex-date passed but broker qty not adjusted yet → valuation factor", () => {
    expect(pendingFactor("INFY", "2026-11-10", [split("2026-11-09")], [opening])).toBe(2);
  });

  it("once the split is in the ledger, or before its ex-date, the factor is 1", () => {
    const applied = ev({ type: "split", source: "inferred", date: "2026-11-10", exDate: "2026-11-09", qty: 10, ratio: { num: 2, den: 1 } });
    expect(pendingFactor("INFY", "2026-11-10", [split("2026-11-09")], [opening, applied])).toBe(1);
    expect(pendingFactor("INFY", "2026-11-08", [split("2026-11-09")], [opening])).toBe(1);
  });
});
