# 0006. Prices served from the DB; Yahoo primary, MCP quote fallback; raw storage

- Status: Accepted
- Date: 2026-11-11

## Context

Every page needs current prices for Indian and US holdings. Yahoo is free and covers both markets, but rate-limits per IP and is stricter for datacenter IPs (Vercel), and needs a browser User-Agent. `quoteSummary` additionally needs a cookie+crumb pair. Yahoo's `close` is split-adjusted back in time, so a split reported later silently rewrites history. The broker MCP servers can quote too, but only through a live broker session.

## Options considered

1. Fetch Yahoo per page view: always fresh, but one Yahoo call per render from a datacenter IP gets 429s fast and makes page latency depend on Yahoo.
2. Cron fetches into the DB, pages read `price_latest`: a few Yahoo calls per 15 minutes regardless of traffic; prices are up to one interval stale.
3. MCP quotes as primary: no Yahoo dependency, but needs a valid Kite/INDmoney session every interval (Kite dies at 06:00 IST) and the tools are per-symbol.

## Decision

Option 2, with MCP as a per-symbol fallback.

- Cron calls `refreshLatest` (`src/lib/market/prices.ts`): one `spark` batch per 20 symbols; symbols missing from the batch get a per-symbol `chart` to tell a definitive 404 from a transient gap; anything still unpriced goes to an injected `QuoteFallback` (U6 wires the MCP quote tool; default no-op). `price_latest.source` records `yahoo` or `mcp`.
- Failure never writes a zero: an unpriced instrument keeps its last stored price. `instruments.price_unavailable` is set only on a definitive 404 that the fallback could not cover either.
- `prices_daily` stores RAW prices: Yahoo bars are multiplied by the cumulative split factor of splits after each bar's date. Splits/bonuses go to `corporate_actions`, dividends (raw, gross) to `dividends`. When a fetch reveals an event not yet stored, the instrument's full history (`range=max`) is re-fetched so all stored bars stay on one basis.
- The `quoteSummary` crumb+cookie is cached in `settings` (`yahoo_crumb`) and refetched once on 401.
- 429 is retried with exponential backoff, at most 3 tries, then surfaces as `YahooRateLimited`.

## Consequences

- Page renders do no market I/O; the owner gets a "refresh now" action for freshness.
- Stored history is immutable under late split reports; consumers adjust in code using `corporate_actions` (the ledger already needs those events).
- Raw conversion depends on Yahoo's split list being complete; a missed split shows as a price cliff. Owner-confirmed bonus rows still count as splits for this, since Yahoo adjusts for bonuses too.
- Revisit if Yahoo blocks Vercel IPs outright: the fallback seam lets MCP (or another source) become primary without touching callers.
