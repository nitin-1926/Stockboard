# 0010. On-demand price freshness on page render, Kite LTP fallback

- Status: Accepted (amends [0006](0006-prices-from-db-yahoo-primary.md): "page renders do no market I/O")
- Date: 2026-11-13

## Context

0006 has pages read `price_latest` only, refreshed by the 15-minute cron (0008). The cron is not running yet, so prices are the last Kite-sync LTPs, and even with it the owner wants live prices while a market is open. Yahoo may 401/429 Vercel datacenter IPs. Google Finance has no API and scraping its HTML is fragile.

## Options considered

1. Cron only (0006 as is): no page latency cost, but stale by up to an interval, and nothing at all until the cron is on.
2. Fetch Yahoo per page view, unguarded: fresh, but every render and every instance hits Yahoo (429s), and page latency follows Yahoo.
3. On-demand refresh with guards: holdings/watchlist call `ensureFresh` before reading; only instruments in an open market whose `as_of` is older than 60 s; 4 s budget then `after()`; per-process in-flight dedupe plus a 15 s cross-instance claim row in `settings`.

## Decision

Option 3, with Kite LTP (`getLtp` via `withKite`) as the `QuoteFallback` for IN instruments Yahoo missed, used by `ensureFresh` and the intraday cron. Closed markets do nothing. A client `LiveRefresh` re-renders every 30 s while the tab is visible. `price_latest.prev_close` stores the previous session close with each price so day change needs no `prices_daily` backfill.

## Consequences

- A render while a market is open may wait up to 4 s for Yahoo; failures are logged and never fail the page.
- Yahoo load is at most one refresh per instrument set per 15 s across instances, whatever the viewer count.
- One `settings` row per distinct instrument set (`live_prices:<hash>`); prune if sets churn.
- Kite LTP only works while the Kite session lives (dies 06:00 IST); US has no fallback yet (INDmoney).
