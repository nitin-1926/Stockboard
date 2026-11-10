import type { Dividend, ISODate, PriceSeries, SplitEvent } from "./types";
import { xirr, type Flow } from "./xirr";

export interface IndexSeries {
  /** Raw (unadjusted) closes, e.g. NIFTYBEES.NS or SPY. */
  closes: PriceSeries;
  dividends?: Pick<Dividend, "exDate" | "perShareGross">[];
  splits?: SplitEvent[];
  /** INR per unit of the index currency (S&P → INR view). Omit for same-currency. */
  fx?: PriceSeries;
  /**
   * Fraction of each index dividend withheld before reinvesting (SPY 25%, India TDS), the
   * same rate the portfolio's own dividends are recorded net of, so alpha is like for like.
   */
  withholdingRate?: number;
}

export interface BenchmarkResult {
  method: "pme" | "direct-alpha";
  portfolioXirr: number | null;
  /** Null under direct-alpha: there is no replicated benchmark portfolio. */
  benchmarkXirr: number | null;
  benchmarkTerminal: number | null;
  alpha: number | null;
}

/** Latest entry on or before `d` (holidays/weekends → previous trading day). */
function atOrBefore(series: PriceSeries, label: string) {
  const dates = Object.keys(series).sort();
  return (d: ISODate) => {
    let lo = 0;
    let hi = dates.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid] <= d) [found, lo] = [mid, mid + 1];
      else hi = mid - 1;
    }
    if (found < 0) throw new Error(`no ${label} on or before ${d}`);
    return { date: dates[found], value: series[dates[found]] };
  };
}

/**
 * Total-return level built from raw closes: dividends (net of `withholdingRate`) reinvested
 * at the ex-date close, splits multiply units so the raw price drop nets out.
 * Yahoo adjclose is not used because stored prices are raw.
 */
export function totalReturnIndex(index: IndexSeries) {
  const close = atOrBefore(index.closes, "close");
  const fx = index.fx && atOrBefore(index.fx, "fx rate");
  const events = [
    ...(index.splits ?? []).map((s) => ({ date: s.exDate, mult: s.ratio })),
    ...(index.dividends ?? []).map((d) => ({
      date: d.exDate,
      mult: 1 + (d.perShareGross * (1 - (index.withholdingRate ?? 0))) / close(d.exDate).value,
    })),
  ];
  // ponytail: O(flows × events) scan; precompute cumulative factors if series get long.
  return (d: ISODate) => {
    const c = close(d);
    const factor = events.filter((e) => e.date <= c.date).reduce((f, e) => f * e.mult, 1);
    return c.value * factor * (fx ? fx(d).value : 1);
  };
}

/**
 * Long-Nickels PME. Each investor-sign flow (negative = buy) buys or sells
 * index units at that date's total-return level; the benchmark's terminal
 * value is units × level on the terminal date. If replicated units go
 * negative (sold more than the index would hold), PME is undefined, so it
 * falls back to direct alpha: the XIRR of flows compounded to the terminal
 * date by the index.
 *
 * `flows` exclude the terminal value; `terminal.amount` is current value.
 * Pass amountInr flows with `fx` for the INR view, native flows without it
 * for the US view.
 */
export function benchmark(flows: Flow[], terminal: Flow, index: IndexSeries): BenchmarkResult {
  const level = totalReturnIndex(index);
  const sorted = [...flows].sort((a, b) => a.date.localeCompare(b.date));
  const portfolioXirr = xirr([...sorted, terminal]);

  let units = 0;
  let negative = false;
  for (const f of sorted) {
    units -= f.amount / level(f.date);
    if (units < -1e-9) negative = true;
  }
  const endLevel = level(terminal.date);

  if (negative) {
    const fv = [...sorted, terminal].map((f) => ({
      date: f.date,
      amount: (f.amount * endLevel) / level(f.date),
    }));
    return {
      method: "direct-alpha",
      portfolioXirr,
      benchmarkXirr: null,
      benchmarkTerminal: null,
      alpha: xirr(fv),
    };
  }

  const benchmarkTerminal = units * endLevel;
  const benchmarkXirr = xirr([...sorted, { date: terminal.date, amount: benchmarkTerminal }]);
  return {
    method: "pme",
    portfolioXirr,
    benchmarkXirr,
    benchmarkTerminal,
    alpha: portfolioXirr === null || benchmarkXirr === null ? null : portfolioXirr - benchmarkXirr,
  };
}
