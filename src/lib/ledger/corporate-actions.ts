import type { CorporateAction, Currency, ISODate, LedgerEvent } from "./types";
import { addDays, effDate, factor } from "./types";

/** Ratio and cost tolerance. */
export const TOL = 0.005;
/** A broker credits a split/bonus a few trading days after the ex-date. */
export const WINDOW_DAYS = 14;

export type ActionMatch =
  | { kind: "none" }
  | { kind: "action"; action: CorporateAction; remainder: number; costPreserved: boolean }
  | { kind: "unexplained"; reason: string };

/**
 * Decide whether a snapshot qty change (ledger L → snapshot Q) is a split or
 * bonus. `actions` are the unapplied ones (see unappliedActions); cost is the
 * weighted-average basis. A candidate's ex-date must lie in
 * [diffDate − 14 days, diffDate].
 * - Q ≥ L×f: credited. `remainder` = Q − L×f (0 within 0.5%) is a concurrent trade.
 * - Q at or below L (for f > 1): not credited yet → none (pendingFactor covers valuation).
 * - In between: ambiguous → unexplained.
 * No candidate but Q×avg ≈ ledger cost: a qty change that adds no cost is not a
 * trade, so it is an unknown corporate action → unexplained.
 */
export function matchCorporateAction(input: {
  ledgerQty: number;
  ledgerCost: number;
  snapshotQty: number;
  snapshotAvg: number;
  diffDate: ISODate;
  actions: CorporateAction[];
}): ActionMatch {
  const { ledgerQty: L, ledgerCost: C, snapshotQty: Q, snapshotAvg: A, diffDate } = input;
  const costPreserved = C > 0 && Math.abs(Q * A - C) <= TOL * C;
  // ponytail: one action per window (latest ex-date); two actions within 14 days would need their product.
  const action = input.actions
    .filter((a) => a.exDate <= diffDate && a.exDate >= addDays(diffDate, -WINDOW_DAYS))
    .sort((a, b) => b.exDate.localeCompare(a.exDate))[0];

  if (!action)
    return costPreserved && Q !== L
      ? { kind: "unexplained", reason: `qty ${L} → ${Q} with cost unchanged: corporate action not on record` }
      : { kind: "none" };

  const f = factor(action.ratio);
  const target = L * f;
  const up = f > 1;
  if (up ? Q >= target * (1 - TOL) : Q <= target * (1 + TOL)) {
    const remainder = Math.abs(Q - target) <= TOL * target ? 0 : Q - target;
    return { kind: "action", action, remainder, costPreserved };
  }
  if (up ? Q <= L : Q >= L) return { kind: "none" };
  return {
    kind: "unexplained",
    reason: `qty ${L} → ${Q} is between pre and post ${action.ratio.num}:${action.ratio.den} quantities (ex ${action.exDate})`,
  };
}

/**
 * Actions for this instrument not yet in the ledger, with ex-date after the
 * ledger's first buy (earlier ones are already in the opening quantity).
 * `events`: non-superseded ledger events.
 */
export function unappliedActions(instrumentId: string, actions: CorporateAction[], events: LedgerEvent[]) {
  const mine = events.filter((e) => e.instrumentId === instrumentId);
  const start = mine
    .filter((e) => e.type === "buy" || e.type === "opening")
    .map((e) => e.date)
    .sort()[0];
  if (!start) return [];
  const applied = new Set(mine.filter((e) => e.type === "split" || e.type === "bonus").map(effDate));
  return actions.filter((a) => a.instrumentId === instrumentId && a.exDate > start && !applied.has(a.exDate));
}

/**
 * Ex-date passed but the broker hasn't credited the new qty yet: valuation
 * multiplies the (pre-adjusted) ledger qty by this factor so history shows no
 * false drop. 1 when nothing is pending.
 */
export const pendingFactor = (instrumentId: string, today: ISODate, actions: CorporateAction[], events: LedgerEvent[]) =>
  unappliedActions(instrumentId, actions, events)
    .filter((a) => a.exDate <= today)
    .reduce((p, a) => p * factor(a.ratio), 1);

/**
 * Ledger event for a corporate action. `date` = the credit (allotment) date, so
 * a bonus lot — or a split the owner later reclassifies as bonus — is dated
 * there; replay applies it at `exDate`. sourceRef is per (instrument, ex-date),
 * so a live match and a historical import of the same action collide on the
 * unique key instead of applying twice.
 */
export const actionEvent = (p: {
  action: CorporateAction;
  date: ISODate;
  heldQty: number;
  currency: Currency;
  fxRateInr: number;
  source: LedgerEvent["source"];
  approximate: boolean;
}): LedgerEvent => {
  const { action: a } = p;
  const sourceRef = `action:${a.instrumentId}:${a.exDate}`;
  return {
    id: sourceRef,
    sourceRef,
    instrumentId: a.instrumentId,
    type: a.kind,
    date: p.date,
    exDate: a.exDate,
    qty: p.heldQty * (factor(a.ratio) - 1),
    price: 0,
    currency: p.currency,
    fxRateInr: p.fxRateInr,
    source: p.source,
    approximate: p.approximate,
    ratio: a.ratio,
  };
};
