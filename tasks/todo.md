# Stockboard rewrite — execution checklist

Plan: `docs/plans/2026-11-11-001-feat-stockboard-rewrite-plan.md` (decision artifact; do not edit its body).
Rule: **no git commits/pushes until the owner explicitly approves** (owner's global CLAUDE.md). Checkpoint at end of Phase 1.

## Owner decisions taken at ce-work start (2026-11-11)
- Fold doc-review P1 fixes into the affected units (listed per unit below). Log each in DEVLOG.md.
- Contributors **can create buckets** (deleting a bucket stays owner-only). This overrides the plan's R3/U15 wording.
- Dividends recorded **net of withholding** (US 25%, India TDS rate configurable in `settings`); gross kept in its own column.
- **Add a US history import:** use an INDmoney MCP transactions tool if one exists, otherwise an INDmoney statement CSV parser. It supersedes US opening events.

## Integration notes from U12 (apply in U11/U15/U17)
- Ledger lots and stored dividends must use the same split basis. Split-adjust `dividends.amount_per_share` (or lot quantities) before calling `heldQtyOn` / `dividendIncome`.
- `Dividend.fxRate` = USD/INR on the pay date, falling back to the ex-date. Ingest fills it the same way it fills `fx_rate_inr`.
- U11 imports `sellFifo` from `src/lib/returns/pnl.ts`. Do not re-implement it. Clamp and flag oversells before calling it, because it throws on oversell.
- Benchmark dividends apply the same withholding as portfolio dividends (SPY 25%, India TDS setting), so the comparison is like for like. This is a one-line multiplier in `benchmark.ts`, to be done in U17.
- Paper bucket members are **equal-weighted** (a fixed notional ₹ amount per item), not price-weighted, so one expensive stock can't dominate the paper return. Change `aggregate.ts` in U15.

## Integration notes from U11a (apply in U10 / U11b)
- Fill `sourceRef` = `fill:<trade_id>`. The trade id must equal Console's `trade_id`. Confirm in U1/U10. If Console trade ids repeat across days, use `csv:<exchange>:<date>:<trade_id>`.
- `takenAt` must carry the timezone offset. Send a 0-qty snapshot when an instrument disappears from holdings.
- Prefetch `priceForDate` and FX before opening the DB transaction.
- Insert remainder events before their supersession link rows. Copy the `refRemap` references in the same transaction.
- `pendingLag` and `unexplained` results go into the review queue (U18).
- The buy residual uses a weighted-average cost basis, which matches how Kite computes `average_price`.

## Integration notes from U11b (apply in U10 / U14 / U15 / U17 / U18 / U20)
- U10 writes `holding_snapshots` (one row per instrument per run, `qty` includes `t1_qty`, `taken_at` = fetch time) in its own transaction, then calls `ingestSnapshotRun(runId)`. Write a 0-qty row for an instrument that was in the previous run and is gone now. Ingest never synthesizes it.
- U10 calls `ingestFills(broker, fills)` with `{ tradeId, instrumentId, side, qty, price, executedAt }`. `executedAt` must be ISO with an offset (ingest throws otherwise). Ingest re-expresses it in the market zone to get the trade date.
- U14 / U15 / U20 push their ref copiers onto `REF_COPIERS` in `src/lib/ledger/ingest.ts`. Signature: `(tx, Map<supersededEventId, supersedingEventIds[]>)`. They run inside the ingest transaction.
- U17 re-prices inferred sells listed as open `approximate_sell` review items. U18 renders `ledger_review_queue`, which holds at most one open item per (instrument, kind).
- `getLedgerState(ids?)` in `src/lib/ledger/queries.ts` is the read API for U13.

## Integration notes from U14 (apply in U10 / U15)
- U10: the prices job must refresh watched instruments too (`watch_items` where `archived_at is null`), not only held ones. Adding an item writes `price_latest` once on demand; after that the cron keeps it fresh.
- U10: once U1 confirms the INDmoney watchlist tool, call `importBrokerWatchlist("indmoney", [{ symbol, market }])` from `src/lib/watch/actions.ts`. It is idempotent, tags `source:indmoney`, stamps the owner's email, and does not resurrect an item the owner archived. Then enable the disabled "Sync from INDmoney (soon)" button.
- U15: watch items are paper members. `watch_items.price_at_add` can be null (no quote at add time); skip or flag those in paper returns.
- Ingest runs `linkWatchedBuys` (new buys) and the `copyWatchLinks` ref copier inside its transaction. U15/U20 copiers go after it in `REF_COPIERS`.

## Integration notes from U15 (apply in U16 / U17 / U18 / U19 / U21)
- U17: bucket alpha shows "Benchmark pending" until `prices_daily` for NIFTYBEES.NS / SPY (and `fx_daily` for US flows) reach back to a bucket's first buy. The backfill alone switches it on; no bucket code change. Index dividends are still gross (the one-line withholding multiplier in `benchmark.ts` is U17's).
- U17: the bucket chart values past days from raw `prices_daily` closes of member instruments (scaled by later ledger splits); a day with no close falls back to the lot's cost. Backfilling member history makes the line real.
- India dividend TDS is read from `settings` key `india_dividend_tds` (a fraction, default 0.10). Whoever builds the settings page writes that key.
- U18/U21: bucket money fields are redacted by `BUCKET_REAL_POLICY` / `MEMBER_POLICY` in `src/lib/views/buckets.ts`; hide-amounts charts are per ₹100 put in. Reuse them for exports.
- U20: journal ref copiers go after `copyBucketMembers` in `REF_COPIERS`. A copier gets one-to-many remaps (one opening → many CSV buys).
- A dynamic-param route forced `NavGroup`/`MobileNav` (usePathname) into `<Suspense>`; later `[id]` routes (U19 symbol page) need nothing more.

## Integration notes from U16 (apply in U17 / U19 / U21)
- U17: after a market's bars are upserted, call `evaluatePendingTargets(asOf, market)` from `src/lib/targets/evaluate-job.ts` (one transaction, idempotent, returns `{ checked, resolved, updated }` for the `sync_runs` counts). `asOf` is a moment; each target is judged on its market's local date. It needs `prices_daily` high/low (close-only bars still work) and `corporate_actions` (split AND bonus rows both rescale the threshold). The U17 integration test ("EOD evaluates a pending target to hit using the day's bar written in the same run") belongs there.
- U19: the symbol page reuses `TargetEditor` from `src/app/(app)/targets/editor.tsx` with `instrument={{ id, symbol, name, exchange, currency, price }}`; `getTargetMarks()` gives the nearest pending levels.
- U21: targets carry no amounts (`TARGET_POLICY` is empty); exports keep price and % columns. `set_by` must become "Owner"/"Contributor" for share-link viewers (`authorLabel` in `src/lib/views/targets.ts`).
- Holdings table minimum width is now ~1062px (fits 1440 with the sidebar; it already scrolled inside its card at 1280 before U16). A further column needs a trade elsewhere.

## Orchestrator notes
- [x] Fixed: manual-vs-authoritative precedence (see DEVLOG)
- U17: a bonus lot must inherit the bucket memberships of the lots it was issued on (pro rata by qty). Otherwise a bucket's return understates the bonus gain. Fix this in the bucket metrics or inheritance step when corporate actions are processed.
- Later: show Kite's weighted-average price as a tooltip next to the FIFO avg cost on Holdings, so the owner can reconcile with the Kite app.

## Owner actions needed (blocking specific units)
- [ ] Google OAuth client (Web): Client ID + secret. Blocks U4 live verification.
  - Authorized JavaScript origins: `http://localhost:3000`, `https://<prod-domain>`.
  - Authorized redirect URIs (exact): `http://localhost:3000/api/auth/callback/google`, `https://<prod-domain>/api/auth/callback/google`.
  - Then set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env.local` (lines already present, empty) and in Vercel production; set `BETTER_AUTH_URL=https://<prod-domain>` in Vercel production.
  - Live check: owner email signs in and reaches `/settings/sharing`; an uninvited Google account lands on `/sign-in?error=NOT_INVITED` with no `user` row created.
- [ ] Spike credentials in `.env.spike.local` (gitignored; owner edits the file directly, never pasted in chat): `KITE_USER_ID`, `KITE_PASSWORD`, `KITE_TOTP_SECRET`. INDmoney uses an interactive browser login during U1. Blocks U1, and therefore U6, U7 and U10.

## Units (with adopted review fixes)

### Phase 0
- [x] U1 Spike (Kite part), 2026-11-12. **Gate: MCP-first for Kite, provisional GO** (findings: `docs/spikes/mcp-findings.md`). Headless chain passed first try; DCR accepts loopback + https in one client; JWT 7 d (Kite session to 06:00 IST); fills = `orders` mode `all_trades` (not `trades`); hosted server also lists write tools → U6 allowlist mandatory. Fixtures: `src/lib/mcp/__fixtures__/kite-*.json`, `src/lib/mcp/kite/__fixtures__/`.
  - [ ] Owner: authorize the Kite Connect Personal app once in a browser (`/connect/authorize` screen blocked step C), then rerun `pnpm tsx scripts/spike/kite-headless.mts` + `scrub.mts` to capture `connect-*.json` and confirm Personal has no `quote/ltp`.
  - [ ] Headless chain from a Vercel function / GitHub runner: deferred to U7 deploy verification (needs creds in cloud env). Gate is provisional until it passes.
  - [ ] Confirm one `all_trades` `trade_id` against the next-day Console tradebook export.
- [ ] U1 Spike (INDmoney part): pending.
- U1 Spike adopted fixes:
  - Also run the headless chain from a Vercel function or GitHub runner. The gate passes only if that run succeeds.
  - Capture scrubbed HTTP-chain fixtures for U7.
  - Probe INDmoney for historical transactions and watchlist tools.
  - Check whether one DCR client accepts both loopback and https redirect URIs.
  - Add a scrubber script for fixtures.

### Phase 1
- [x] U2 Scaffold. Adopted fixes: gitleaks in CI; gitignore `.env*`, spike raw output, `.claude/worktrees/`.
- [x] U3 DB. Adopted fixes:
  - `prices_daily` stores raw (unadjusted) OHLC. Corporate-action events are stored separately.
  - `price_latest.source`.
  - `instruments.price_unavailable` and `instruments.is_benchmark`.
  - Dev Neon branch is schema-only. Dev and preview get secrets separate from prod.
- [x] U4 Auth/access (live Google sign-in pending OAuth client). Adopted fixes:
  - `access_grants` keyed by lowercased email (no FK to users).
  - `requireActor()` in the data-access layer (views and actions), not in the layout.
  - Per-view redaction policy plus tests.
  - Resource-owner rule for contributor edits. Contributors may create buckets.
  - Share-link and invite error pages.
  - Pool client for Better Auth.
  - Google OAuth and auth env vars set up here.
  - Suspense boundaries for runtime data.
- [x] U5 Secrets (settings page deferred to after U4). Adopted fix: set the prod `ENCRYPTION_KEY` here (prod, preview and local dev each have their own key).
- [x] U6 MCP client (Kite part), 2026-11-12. `withMcp` (`src/lib/mcp/client.ts`), strict `tool:mode` allowlist + zod wrappers (`src/lib/mcp/kite/tools.ts`), JWT provider + one DCR client with both redirect URIs (`src/lib/mcp/kite/auth.ts`). Adopted fixes:
  - [x] OAuth `state` bound to the owner session, with the owner session required on the callback (Kite: hash + single-use + 10 min in DB, raw state in an httpOnly cookie, `authorize("manage")` on both routes).
  - [ ] INDmoney refresh owned by us: proactive, under an advisory lock, using a minimal AuthProvider. `OAuthClientProvider` is used only for consent. (INDmoney part pending.)
  - [ ] Scopes `portfolio:read market:read` only. (INDmoney part pending.)
- [ ] U6 MCP client (INDmoney part): pending U1 INDmoney.
- [x] U7 Kite headless login, 2026-11-12. `src/lib/mcp/kite/headless-login.ts`, `/api/connect/kite` (+ `/callback`), `kite-login` job = login + profile read. Live local run: pass (connected, JWT 168 h, profile read OK). Adopted fix: state binding on the manual connect flow (done, see U6).
  - [ ] Owner: set `APP_URL=https://<prod-domain>` in Vercel production (the DCR https redirect URI and callback use it).
  - [ ] Owner: after deploy, re-save Kite credentials on prod `/settings/brokers` if prod's `ENCRYPTION_KEY` differs from `.env.local`'s (the live run wrote them with the local key into the Vercel-linked DB).
  - [ ] Deploy verification: trigger `kite-login` from the deployed app (Vercel IP) once, then confirm the next scheduled morning run. Gate for U1 stays provisional until then.
- [x] U8 Market data. Adopted fixes:
  - Seed benchmark instruments NIFTYBEES.NS and SPY.
  - Store raw prices.
  - Refetch full history when a new split or dividend appears.
- [x] U9 Cron infra. Adopted fixes:
  - DST-aware US price window: 13:30–21:00 UTC plus a timezone check.
  - `backfill.yml` loop.
  - Second kite-sync run at 17:00 IST.
  - Schedule-aware staleness check.
  - Recover stuck `running` rows.
  - Set `CRON_SECRET` and GitHub secrets here.
- [x] U10 Sync jobs (Kite part), 2026-11-12. `src/lib/jobs/kite-sync.ts` (`kite-sync` job; `kite-login` chains it), `margins_latest` (0010), Overview margins card, owner "Sync Kite now" + last sync on `/settings/brokers`. Snapshot qty = holdings `quantity` + `t1_quantity` + today's CNC day buys (symbol match across exchanges); first-sight openings exclude today's fills. Adopted fixes:
  - [x] Snapshots keyed by run.
  - [x] On `SessionExpired`, re-login once and retry.
  - [x] No staging table: INDmoney watchlist import moves to U14.
  - [ ] Owner: after deploy, re-enter Kite creds on prod if needed, press "Run automatic login now" (it chains a sync), check the snapshot against the Kite app.
  - [ ] Watch `top_ups` in kite-sync counts: a same-day buy of an already-held symbol (unobserved in U1) — confirm holdings `quantity` excludes it, else the rule double counts.
- [ ] U10 Sync jobs (INDmoney part): pending U1/U6 INDmoney.
- [ ] **Checkpoint: ask the owner to approve repo creation and first push (retroactive-commit-history), then set GitHub secrets.**

### Phase 2
- [x] U11 Ledger (US history format to be confirmed in U1). Adopted fixes:
  - Residual inference against the ledger replay, with idempotent `source_ref`.
  - Supersession link table; copy bucket, watch and journal refs onto replacing events.
  - Corporate-action window match plus a pending state; on-demand split fetch; split+buy branch.
  - Bonus lot dated at allotment.
  - On-demand price for inferred sells.
  - CSV import: prefetch FX for the range outside the transaction, fetch split history, reconcile the residual.
  - US history import.
  - [x] U11a pure core (infer, corporate-actions, lots, supersede, csv parse) done
  - [x] U11b DB layer (schema/ledger.ts, ingest.ts, queries.ts, /settings/import) done
- [x] U12 Returns. Adopted fixes: dividends net of withholding; benchmark total return from raw close plus dividends.
- [x] U13 Shell/Overview/Holdings. Adopted fixes:
  - Bucket tabs and upside move to U15 and U16.
  - Role-conditional controls; state matrix; connection banner spec; Suspense.
- [x] U14 Watchlist. Adopted fix: INDmoney watchlist import if a tool exists. INDmoney watchlist sync wired after U1 (`importBrokerWatchlist` ready; U10 calls it once the tool is confirmed).
- [x] U15 Buckets. Adopted fixes: bucket tabs on holdings; contributors create buckets; owner-only delete; resource-owner rule.
- [x] U16 Targets. Adopted fixes: upside on holdings; resource-owner rule; EOD verification moves to U17. EOD wiring in U17 (`evaluatePendingTargets` ready).

### Phase 3
- [x] U17 EOD. Adopted fixes: benchmark backfill; re-price inferred sells at the official close. Also wired prices-intraday; broker jobs return `{blocked}` until U6/U7/U10. No `portfolio_values` table (U18 derives history on read).
- [x] U18 History/trades/ledger views. Adopted fixes: redacted (normalized) series; anomaly review queue. History derived on read (no `portfolio_values`); owner corrections via `correctEvent` / `reclassifyAsBonus` / `resolveReviewItem` in `ingest.ts`; Ledger page under Settings.
- [x] U19 Allocation/symbol/news. Symbol page is the third target-editor entry point; Kite weighted avg shown next to FIFO avg there; preferences page writes `india_dividend_tds`.
- [x] U20 Journal. Adopted fix: resource-owner rule. `journal_entries` (0009), suggest-level create, edit_own edit/soft delete; superseded buy entries move to the first superseding buy (`copyJournalRefs` in `REF_COPIERS`); Due for review on Overview + Targets.
- [x] U21 Export. Adopted fixes: formula-injection neutralization; hide-amounts exports keep % and price columns. `/api/export/[kind]` (holdings|buckets|trades|ledger, csv|xlsx) reuses the view builders; ledger owner-only (403), signed out 401.

### Phase 4
- [ ] U22 Smoke/docs/ship
- [ ] U23 Remove old app (explicit owner confirmation before `rm`)

## Review
(filled at the end)
