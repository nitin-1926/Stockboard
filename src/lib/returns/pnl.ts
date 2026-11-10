import type { CashFlow, ClosedPortion, Dividend, ISODate, Lot } from "./types";

/** US withholding on dividends paid to an Indian resident (treaty rate). */
export const US_DIVIDEND_WITHHOLDING = 0.25;

const openQty = (lot: Lot) => lot.qty - lot.closed.reduce((s, c) => s + c.qty, 0);

/**
 * Match a sale against lots, earliest openDate first. Returns new lots; the
 * input is not mutated. Throws when the sale exceeds the open quantity: the
 * ledger (U11) clamps and flags such data gaps before calling this.
 */
export function sellFifo(lots: Lot[], sale: ClosedPortion): Lot[] {
  const sorted = [...lots].sort((a, b) => a.openDate.localeCompare(b.openDate));
  let remaining = sale.qty;
  const out = sorted.map((lot) => {
    const take = Math.min(remaining, openQty(lot));
    if (take <= 0) return lot;
    remaining -= take;
    return { ...lot, closed: [...lot.closed, { ...sale, qty: take }] };
  });
  if (remaining > 1e-9) throw new Error(`sale of ${sale.qty} exceeds open quantity`);
  return out;
}

/**
 * Shares entitled to a dividend: bought before the ex-date and not sold before
 * it (a sale on the ex-date still receives the dividend).
 */
export const heldQtyOn = (lots: Lot[], exDate: ISODate): number =>
  lots
    .filter((l) => l.openDate < exDate)
    .reduce(
      (s, l) => s + l.qty - l.closed.filter((c) => c.date < exDate).reduce((t, c) => t + c.qty, 0),
      0,
    );

/**
 * Dividend income, recorded net of withholding (US 25%, India TDS from
 * settings) with gross kept alongside. Dated on the pay date, else ex-date.
 */
export function dividendIncome(lots: Lot[], div: Dividend, withholdingRate: number) {
  const qty = heldQtyOn(lots, div.exDate);
  const grossNative = qty * div.perShareGross;
  const netNative = grossNative * (1 - withholdingRate);
  return {
    date: div.payDate ?? div.exDate,
    qty,
    grossNative,
    netNative,
    grossInr: grossNative * div.fxRate,
    netInr: netNative * div.fxRate,
  };
}

/**
 * P&L for one instrument's lots, in native currency and INR. Cost INR uses
 * each lot's buy-date rate; realized INR uses the sale-date rate.
 * `flows` are investor-sign cash flows (buys, sales, net dividends, current
 * value on `asOf`) for XIRR and the benchmark.
 */
export function positionPnl(input: {
  lots: Lot[];
  price: number;
  fxNow: number;
  asOf: ISODate;
  dividends?: Dividend[];
  withholdingRate?: number;
}) {
  const { lots, price, fxNow, asOf, dividends = [], withholdingRate = 0 } = input;
  let qty = 0;
  let costNative = 0;
  let costInr = 0;
  let realizedNative = 0;
  let realizedInr = 0;
  const flows: CashFlow[] = [];

  for (const lot of lots) {
    const buy = lot.qty * lot.costPerShare;
    flows.push({ date: lot.openDate, amountNative: -buy, amountInr: -buy * lot.fxRateAtOpen });
    for (const c of lot.closed) {
      const proceeds = c.qty * c.pricePerShare;
      realizedNative += proceeds - c.qty * lot.costPerShare;
      realizedInr += proceeds * c.fxRate - c.qty * lot.costPerShare * lot.fxRateAtOpen;
      flows.push({ date: c.date, amountNative: proceeds, amountInr: proceeds * c.fxRate });
    }
    const open = openQty(lot);
    qty += open;
    costNative += open * lot.costPerShare;
    costInr += open * lot.costPerShare * lot.fxRateAtOpen;
  }

  let dividendsGrossInr = 0;
  let dividendsNetInr = 0;
  for (const div of dividends) {
    const d = dividendIncome(lots, div, withholdingRate);
    if (d.qty <= 0) continue;
    dividendsGrossInr += d.grossInr;
    dividendsNetInr += d.netInr;
    flows.push({ date: d.date, amountNative: d.netNative, amountInr: d.netInr });
  }

  const valueNative = qty * price;
  const valueInr = valueNative * fxNow;
  flows.push({ date: asOf, amountNative: valueNative, amountInr: valueInr });
  flows.sort((a, b) => a.date.localeCompare(b.date));

  const unrealizedInr = valueInr - costInr;
  return {
    openQty: qty,
    costNative,
    costInr,
    valueNative,
    valueInr,
    unrealizedNative: valueNative - costNative,
    unrealizedInr,
    realizedNative,
    realizedInr,
    dividendsGrossInr,
    dividendsNetInr,
    totalReturnInr: unrealizedInr + realizedInr + dividendsNetInr,
    flows,
  };
}

export type PositionPnl = ReturnType<typeof positionPnl>;
