/**
 * Split an open position's INR return into its native-currency part and the
 * FX contribution (ADR-0007). Cost INR uses each lot's buy-date rate, so
 * fxContribution = INR return − native return (includes the cross term).
 * Accepts a positionPnl() result directly.
 */
export function fxReturns(p: {
  costNative: number;
  costInr: number;
  valueNative: number;
  valueInr: number;
}): { nativeReturn: number | null; inrReturn: number | null; fxContribution: number | null } {
  if (p.costNative <= 0 || p.costInr <= 0) {
    return { nativeReturn: null, inrReturn: null, fxContribution: null };
  }
  const nativeReturn = p.valueNative / p.costNative - 1;
  const inrReturn = p.valueInr / p.costInr - 1;
  return { nativeReturn, inrReturn, fxContribution: inrReturn - nativeReturn };
}
