import type { ISODate } from "./types";

/** Investor-sign flow in one currency: negative = money in, positive = money out. */
export interface Flow {
  date: ISODate;
  amount: number;
}

const DAY_MS = 86_400_000;

export const daysBetween = (from: ISODate, to: ISODate): number =>
  Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

const BRACKET: [number, number] = [-0.9999, 10];
const TOL = 1e-12;

type Prepared = { t: number; a: number }[]; // t in years (Excel's /365)

function prepare(flows: Flow[]): Prepared | null {
  if (!flows.some((f) => f.amount < 0) || !flows.some((f) => f.amount > 0)) return null;
  const start = flows.reduce((m, f) => (f.date < m ? f.date : m), flows[0].date);
  return flows.map((f) => ({ t: daysBetween(start, f.date) / 365, a: f.amount }));
}

const npv = (p: Prepared, r: number) => p.reduce((s, { t, a }) => s + a / (1 + r) ** t, 0);
const dnpv = (p: Prepared, r: number) =>
  p.reduce((s, { t, a }) => s - (t * a) / (1 + r) ** (t + 1), 0);

function newton(p: Prepared): number | null {
  let r = 0.1;
  for (let i = 0; i < 100; i++) {
    const next = r - npv(p, r) / dnpv(p, r);
    if (!Number.isFinite(next) || next <= -1) return null;
    if (Math.abs(next - r) < TOL) return next;
    r = next;
  }
  return null;
}

function bisect(p: Prepared): number | null {
  let [lo, hi] = BRACKET;
  let fLo = npv(p, lo);
  if (fLo * npv(p, hi) > 0) return null;
  while (hi - lo > TOL) {
    const mid = (lo + hi) / 2;
    const fMid = npv(p, mid);
    if (fLo * fMid <= 0) hi = mid;
    else [lo, fLo] = [mid, fMid];
  }
  return (lo + hi) / 2;
}

/** Newton only, from 0.1. Exported so tests can prove a fixture defeats it. */
export function xirrNewton(flows: Flow[]): number | null {
  const p = prepare(flows);
  return p && newton(p);
}

/**
 * Excel-compatible XIRR (actual/365). Newton from 0.1, falling back to
 * bisection on [-0.9999, 10]. Null without both negative and positive flows,
 * or when neither method finds a root.
 */
export function xirr(flows: Flow[]): number | null {
  const p = prepare(flows);
  return p && (newton(p) ?? bisect(p));
}

/**
 * Holdings spanning under 365 days show absolute return, not XIRR
 * (annualizing a 10-day move produces absurd numbers).
 * absolute = money out / money in − 1.
 */
export function annualizeOrAbsolute(flows: Flow[]): {
  useAbsolute: boolean;
  absolute: number | null;
  xirr: number | null;
} {
  let moneyIn = 0;
  let moneyOut = 0;
  for (const f of flows) {
    if (f.amount < 0) moneyIn -= f.amount;
    else moneyOut += f.amount;
  }
  const dates = flows.map((f) => f.date).sort();
  const span = dates.length ? daysBetween(dates[0], dates[dates.length - 1]) : 0;
  const useAbsolute = span < 365;
  return {
    useAbsolute,
    absolute: moneyIn > 0 ? moneyOut / moneyIn - 1 : null,
    xirr: useAbsolute ? null : xirr(flows),
  };
}
