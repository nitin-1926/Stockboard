import { positionPnl, type PositionPnl } from "./pnl";
import type { CashFlow, ISODate } from "./types";
import { annualizeOrAbsolute } from "./xirr";

/**
 * Paper members are equal-weighted: each is a fixed notional ₹ amount "bought" at add
 * time, so one high-priced stock can't dominate the paper return (U12 integration note,
 * overrides the plan's one-unit wording).
 */
export const PAPER_NOTIONAL_INR = 10_000;

/** A watch item / paper bucket member, bought for PAPER_NOTIONAL_INR at add time. */
export interface PaperItem {
  priceAtAdd: number;
  addedAt: ISODate;
  price: number;
  /** INR per unit of the item's currency; default 1 (INR). */
  fxAtAdd?: number;
  fxNow?: number;
}

export type PositionInput = Omit<Parameters<typeof positionPnl>[0], "asOf">;

const inr = (cfs: CashFlow[]) => cfs.map((c) => ({ date: c.date, amount: c.amountInr }));

/**
 * Bucket or portfolio metrics in INR. Real money totals come only from lots;
 * paper items get their own % returns and join real ones only in `combined`.
 */
export function aggregate(input: { positions: PositionInput[]; paper: PaperItem[]; asOf: ISODate }) {
  const { positions, paper, asOf } = input;
  const pnls = positions.map((p) => positionPnl({ ...p, asOf }));
  const sum = (k: Exclude<keyof PositionPnl, "flows">) => pnls.reduce((s, p) => s + p[k], 0);

  const realFlows = pnls.flatMap((p) => p.flows);
  const paperFlows: CashFlow[] = paper.flatMap((i) => [
    { date: i.addedAt, amountInr: -PAPER_NOTIONAL_INR },
    { date: asOf, amountInr: (PAPER_NOTIONAL_INR * i.price * (i.fxNow ?? 1)) / (i.priceAtAdd * (i.fxAtAdd ?? 1)) },
  ]);

  return {
    real: {
      costInr: sum("costInr"),
      valueInr: sum("valueInr"),
      unrealizedInr: sum("unrealizedInr"),
      realizedInr: sum("realizedInr"),
      dividendsGrossInr: sum("dividendsGrossInr"),
      dividendsNetInr: sum("dividendsNetInr"),
      totalReturnInr: sum("totalReturnInr"),
      flows: realFlows,
      returns: annualizeOrAbsolute(inr(realFlows)),
    },
    paper: { count: paper.length, returns: annualizeOrAbsolute(inr(paperFlows)) },
    combined: annualizeOrAbsolute(inr([...realFlows, ...paperFlows])),
  };
}
