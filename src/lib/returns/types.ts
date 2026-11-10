/**
 * Minimal inputs for the returns engine (U12). The ledger (U11) produces these.
 *
 * Precision: plain JS numbers (float64). Returns and ratios need no more, and
 * money amounts stay well inside 2^53 paise. Nothing here rounds; rounding
 * happens only at presentation. Tests compare amounts with toBeCloseTo.
 *
 * Dates are ISO `YYYY-MM-DD` strings, treated as UTC calendar days.
 */

export type ISODate = string;
export type Market = "IN" | "US";
export type Currency = "INR" | "USD";

/** One sale matched against a lot. */
export interface ClosedPortion {
  qty: number;
  date: ISODate;
  /** Sale price per share, native currency. */
  pricePerShare: number;
  /** INR per unit of the lot's currency on the sale date (1 for INR). */
  fxRate: number;
}

/**
 * One acquisition. `qty` is the original quantity, already split-adjusted by
 * the ledger; the open quantity is `qty` minus the closed portions. A bonus
 * lot is its own Lot with cost 0 and `openDate` = allotment date.
 */
export interface Lot {
  instrumentId: string;
  market: Market;
  currency: Currency;
  qty: number;
  /** Native currency. */
  costPerShare: number;
  openDate: ISODate;
  /** INR per unit of `currency` on `openDate` (1 for INR). */
  fxRateAtOpen: number;
  closed: ClosedPortion[];
}

/** Investor-sign cash flow: negative = money in, positive = money out. */
export interface CashFlow {
  date: ISODate;
  amountInr: number;
  amountNative?: number;
}

export interface Dividend {
  exDate: ISODate;
  payDate?: ISODate;
  perShareGross: number;
  currency: Currency;
  /** INR per unit of `currency` on the pay date (ex-date if no pay date). */
  fxRate: number;
}

/** date → raw (unadjusted) close, trading days only. */
export type PriceSeries = Record<ISODate, number>;

/** `ratio` new shares per old share (2:1 split → 2). */
export interface SplitEvent {
  exDate: ISODate;
  ratio: number;
}
