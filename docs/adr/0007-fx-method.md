# 0007. FX method: INR base, buy-date rate, FX contribution

- Status: Accepted
- Date: 2026-11-11

## Context

US holdings are bought in USD but the owner measures wealth in INR. Returns must show how much of a US position's INR gain came from the stock and how much from the rupee moving. Rates come from ECB via Frankfurter v1, which has no weekend or holiday rates.

## Options considered

1. INR base, each lot converted at its buy-date rate: INR cost is what the owner actually paid; FX effect is separable. Needs a stored daily rate history.
2. Convert everything at today's rate: simple, but hides the FX effect entirely and makes INR cost drift daily.
3. Report US holdings in USD only: no FX mixing, but no single INR portfolio total.

## Decision

Option 1.

- INR is the base currency for all totals, XIRR and benchmarks.
- A lot's INR cost = native cost × the `fx_daily` rate on its buy date. Sales use the sale-date rate, dividends the pay-date rate (ex-date if none), current value today's rate.
- `fx_daily` stores the ECB rate daily, with weekends and holidays forward-filled from the previous business day.
- FX contribution = INR return − native return (`src/lib/returns/fx-returns.ts`). It includes the price × FX cross term rather than splitting it out, so the two parts always sum to the INR return.
- Holdings that predate the ledger use the first-sync date and carry an `approximate` flag until the owner edits the date or imports trades.

## Consequences

- Every US ledger event needs a non-null rate, so ingest (U11) fetches missing dates on demand.
- The S&P benchmark is converted through the same series, so INR alpha and USD alpha are both available.
- Approximate opening lots carry the first-sync rate, so their FX contribution is understated until real trade dates are imported.
