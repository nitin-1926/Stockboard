# DEVLOG — stockboard

> A running, append-only log of every substantive bug fix, feature, refactor, build/CI change, and decision that shapes this project. Written *during* the session that made the change so that future blog posts, LLM-mistake pattern analysis, or context-restoration reads can reconstruct the journey without spelunking through git history.

This file may be **local-only and gitignored** (maintainer journal) or **committed** (team-visible decision log) — check `.gitignore` to see which mode this project uses. This project commits it.

---

## Problem statement

Stockboard is a personal, read-only portfolio dashboard for Indian (Zerodha Kite) and US (INDmoney) holdings. It ingests holdings and trades by acting as a deterministic MCP client of the brokers' MCP servers, keeps an event-sourced ledger, computes returns (XIRR, FX contribution, benchmark PME, tax lots), and shares views with invited viewers under server-side redaction. It must run at zero hosting cost: Next.js on Vercel Hobby, Neon Postgres free tier, cron via GitHub Actions.

---

## Baseline (state before this log begins)

- Empty repo with the rewrite plan (`docs/plans/2026-11-11-001-feat-stockboard-rewrite-plan.md`) and execution checklist (`tasks/todo.md`).
- The plan is the decision artifact; its body is not edited. Owner decisions taken at work start live in `tasks/todo.md`.
- Out of scope: placing orders or any write to broker accounts, an LLM on the data path, paid infrastructure.
- No git commits or pushes until the owner explicitly approves (checkpoint at end of Phase 1).

---

## Entry template

Every new entry follows this skeleton. Keep it compact — the goal is fast scan, not novel-length prose. Link out instead of restating.

```markdown
### YYYY-MM-DD — <one-line title naming the artifact + change>

- Type: bug | feature | refactor | build | docs | chore
- Scope: <files / packages / commands affected>

Reasoning / RCA / research:
    <1-6 bullets. For bugs: what broke, root cause, why the obvious fix
    was wrong. For features: why it matters, what alternatives were
    considered and rejected. For refactors: what changed in shape
    without changing behavior, and what motivated the reshape.>

Implementation summary:
    <1-6 bullets. What code moved, what files were added/deleted, what
    tests landed, what verification ran.>

Follow-ups deferred:
    <Optional. Known unfinished work — anything you intentionally
    decided NOT to do in this change, with the reason.>
```

### Style rules

- **Capture *why*, not *what*.** The diff already shows what. The journal earns its keep by recording decisions.
- **Name files affected** so a future grep finds the entry from a path.
- **State tradeoffs explicitly:** "considered X but Y because Z." A rejected option is more valuable than the chosen one when read six months later.
- **Note failed approaches.** If you tried fix A and it didn't work before fix B did, both belong — the dead-end teaches.
- **Each bullet ≤2 sentences.** If you need more, link to a longer doc and summarize.
- **Don't paraphrase the diff.** "Renamed `foo` to `bar`" is useless; "renamed `foo` to `bar` because `foo` collided with the new public API for the upgrade path" is the entry.

### Anti-patterns

- **Don't batch unrelated changes** into one entry. One logical change per entry.
- **Don't write entries days later.** Context decays in hours. Write while it is fresh.
- **Don't edit past entries.** Correct factual errors with a *new* entry that references the old one. The chronology is the point.
- **Don't omit the boring-looking changes.** Build/CI/docs changes shape the project's behavior over time and surface in pattern analysis.

New entries go at the **top** of the Log section (reverse chronological).

---

## Log

### 2026-11-13 — Tests no longer leak fake holdings into the live dashboard

- Type: fix
- Scope: `src/lib/views/holdings.ts` (`latestSnapshotRunIds`), `vitest.config.ts`, `package.json` (`test:db`), `src/lib/jobs/prices-intraday.test.ts`, `src/lib/market/live.test.ts`
- Correction from owner: "why do I see test data instead of real data".

Reasoning / RCA / research:
    - Local and prod share one database (owner's choice). The Neon integration tests write rows with `test-…` job names and clean up afterwards, but while a kite-sync test runs its completed fixture snapshot is the newest one, and `latestSnapshotRunIds` picked it, so the live site showed TEST_ holdings. Running the suite during development made this visible.
    - Fix 1 (root): the visible portfolio ignores sync runs whose job starts with `test-`, so a test can never become the latest snapshot.
    - Fix 2 (blast radius): DB tests are opt-in. `pnpm test` (and CI) no longer load .env.local, so they skip; `pnpm test:db` runs them deliberately. Other test rows (watch items, events) still appear for seconds during a `test:db` run.
    - Rejected: a separate test database (owner wants one DB), per-test schemas (heavy for a personal app).
    - Also fixed a time bomb in live.test: the mocked Kite token expiry was pinned to a fixed date but compared with the real clock.

### 2026-11-13 — Kite sync hourly, NSE prices every 5 min; old Flask dir removed

- Type: chore
- Scope: `.github/workflows/cron-{prices,kite-sync}.yml`, `src/lib/jobs/schedule.ts` + test, `docs/plans/...rewrite-plan.md`
- Owner request: Kite sync every hour and prices every 5 minutes during 09:15-15:30 IST; keep one database for local and prod.

Reasoning / RCA / research:
    - Load is small: one Yahoo spark batch per 5 minutes (about 35 symbols) and about 6 Kite MCP calls per hourly sync, far under either provider's limits. GitHub Actions minutes are free for a public repo.
    - GitHub's scheduler can delay or drop runs at busy times, so 5 minutes is a target, not a guarantee. Page loads still refresh stale prices on their own (ADR 0010), so a dropped run costs nothing visible.
    - `SCHEDULES` mirrors the workflow crons so connection banners judge staleness correctly. kite-sync grace dropped from 150 to 90 minutes to match the hourly cadence; the 17:00 IST run stays as a self-heal.
    - NYSE prices stay every 15 minutes (owner asked only about the NSE window).
    - Local and prod deliberately share one Neon database (owner decision: easier to check, validate and fix against real data). Consequence: local and prod ENCRYPTION_KEYs differ, so Kite credentials saved in one can't be read by the other.
    - The old Flask directory was deleted and this project moved to `Projects/Stockboard`. The plan doc's references to the upstream fork were scrubbed.

### 2026-11-13 — UI redesign: graphite + saffron, top nav, decluttered pages

- Type: refactor (UI)
- Scope: `docs/design/SYSTEM.md` (new), `src/app/globals.css`, `src/app/layout.tsx` (IBM Plex), `src/app/(app)/layout.tsx` (top bar, market status, LiveRefresh), `src/components/{panel,page-header}.tsx` (new), shared atoms, every page under `src/app/(app)`, sign-in, share pages
- Correction from owner: "The UI is TRASH", no bluish-black, sharp fonts, too many complex/useless things.

Reasoning / RCA / research:
    - Root causes of the old look: shadcn defaults barely customised (slate hue 260 → bluish-black), a sidebar eating 240px from dense tables, an explainer paragraph under every heading, and provenance plumbing (≈, source badges, LTCG, held-for, upside "Set") in primary tables.
    - Direction: Kite restraint + Mercury neutrals + Linear density. Warm graphite neutrals (oklch hue 85, chroma <= 0.006) so neither theme reads blue; one saffron accent for active nav, focus and chart line; color otherwise only for gain/loss. IBM Plex Sans for UI and figures (tabular), Plex Mono only for codes. Radius 6px everywhere.
    - Rejected: keeping Geist (fine type, but the owner asked for a visibly different, sharper feel), a lime/green accent (collides with gain), mono tickers (read as code; tried, switched to Plex Sans semibold).
    - IA: History and Allocation folded into Overview; Ledger moved under Settings tabs; Settings is one tabbed page. Provenance stays on the ledger and symbol pages only.
    - Manual sector override (ETFs) moved from the deleted Allocation page to the symbol page header (owner only).

Implementation summary:
    - Page work split across parallel agents on disjoint files; shared primitives and the shell done first so pages composed from them.
    - Verified with screenshots at 1440 and 390, light and dark, on live data via the dev bypass below.

### 2026-11-13 — Trades page: today's buys and sells only

- Type: feature
- Scope: `src/app/(app)/trades/page.tsx`, `src/app/(app)/trades/sync-button.tsx` (new)
- Correction from owner: "The trades section is very very broken and is unusable. I just wanted a simple thing."

Reasoning / RCA / research:
    - The old page was the full ledger feed (openings bootstrapped on first sync, inferred diffs, dividends, splits, superseded rows), so day one showed every holding as a trade.
    - Kite reports each partial fill as its own trade (PGEL: 7 fills for one sell); the page merges fills per instrument and side per day (sum qty and value, weighted average price, earliest time) and shows "N fills" under qty.
    - Owner-only "Sync now" reuses `runKiteSyncNow` so today's fills appear without waiting for the evening sync. Export kept.

### 2026-11-13 — Dev-only auth bypass for local UI review

- Type: chore
- Scope: `src/lib/auth/dev-bypass.ts` (new), `src/lib/auth/access.ts`, `src/proxy.ts`, `package.json` (`next dev -p 7777`)

Reasoning / RCA / research:
    - The owner asked for it: Google sign-in can't be completed inside the automation browser, and the registered local OAuth callback is port 7777.
    - Acts as OWNER_EMAIL only when NODE_ENV is "development", VERCEL is unset and DEV_AUTH_BYPASS=1 (in the git-ignored .env.local). Every deployed build has NODE_ENV=production and VERCEL set, so the branch is dead there. Checked after session and share cookie, so real sessions still win.

### 2026-11-13 — Company names fetched automatically on Kite sync

- Type: fix
- Scope: `src/lib/market/prices.ts` (`enrichInstrument` sets name), `src/lib/jobs/kite-sync.ts` (`enriched` counter)

Reasoning / RCA / research:
    - Kite holdings carry only the trading symbol, so every instrument's name equalled its symbol and tables showed "SAGILITY / SAGILITY". Enrichment existed but only behind a manual Allocation button.
    - Each sync now enriches up to 10 instruments whose name is null or equals the symbol (Yahoo quoteSummary also fills sector/market cap). Bounded and best-effort: a Yahoo rate limit stops the loop and never fails the sync. Names stick once set, so ETFs (no sector) are not retried forever.

### 2026-11-13 — Daily trades view: what was bought or sold, today first

- Type: feature
- Scope: `src/lib/views/trades.ts` (`getDailyTradesView`, `buildDailyTrades`, `DAILY_TRADE_POLICY`, `DAILY_TOTALS_POLICY`) + `trades.test.ts`

Reasoning / RCA / research:
    - The owner found the event feed (openings, inferred diffs, dividends, splits, superseded history) unusable for "what did I trade". The new view keeps only real executions: sources `fill`, `csv`, `us_history`, types buy/sell, not superseded. Existing `buildTrades` / `getTradesView` stay for the ledger page and the export.
    - `manual` corrections are excluded per the brief, even though they usually restate a real trade; revisit if the owner misses them.
    - Days are IST calendar dates for both markets (owner is in India): a US fill at 15:30 New York groups under the next IST day. Rows without a time use their trade date.
    - Today's Kite trades arrive as `fill:<trade_id>` events from kite-sync → `ingestFills` (fills land before inference), so they show once the day's sync has run. No intraday fill polling was added.
    - Redaction matches `TRADE_POLICY`: qty and values (plus today's buy/sell INR totals) are removed for hide-amounts viewers; price, side, time stay.

Implementation summary:
    - 4 pure tests: exclusions (opening, inferred, superseded, dividend, split, out of window), IST grouping of a US fill, totals, empty today and `days` window, redaction.

### 2026-11-13 — On-demand live prices (ensureFresh), Kite LTP fallback, price_latest.prev_close

- Type: feature
- Scope: `src/lib/market/live.ts` + `live.test.ts` (new), `src/lib/market/prices.ts`, `src/lib/market/yahoo.ts` + test, `src/lib/market/instruments.ts`, `src/lib/jobs/prices-intraday.ts`, `src/lib/jobs/kite-sync.ts`, `src/lib/views/{holdings,watchlist}.ts` + holdings test, `src/db/schema/market.ts` + `drizzle/0011_price_latest_prev_close.sql`, `src/components/live-refresh.tsx` (new), `docs/adr/0010-on-demand-live-prices.md`

Reasoning / RCA / research:
    - Prices were stale because only the GitHub Actions cron refreshes them and it is not running yet; `price_latest` held the last Kite-sync LTPs (source `broker`). Even with the cron, 15-minute prices aren't "live". ADR 0010 amends 0006's "no market I/O on render".
    - Rejected: Google Finance (no API, HTML scraping is fragile); unguarded per-render Yahoo (429s from Vercel IPs, latency tied to Yahoo). Chosen: refresh only open-market instruments older than 60 s, 4 s budget then `after()`, per-process in-flight dedupe, and an atomic 15 s claim row in `settings` per instrument set so parallel instances don't stampede.
    - A single global claim key would starve one of two open tabs (holdings + watchlist) whose refresh ticks are under 15 s apart, so the key is a hash of the set.
    - `as_of` is Yahoo's quote time, which lags for illiquid symbols, so the 60 s staleness check alone would refresh on every render; the 15 s claim is the real throttle.
    - Yahoo 401/403 now count as "blocked" like a persisted 429: stop the per-symbol chart loop and hand everything to the fallback. Kite LTP is the IN fallback (checks connection status first, never throws); it is not the default `refreshLatest` fallback so DB tests that stub fetch can't reach the real Kite connection.
    - Day change was "–" because `prices_daily` was never backfilled. `prev_close` is now written with each price: Yahoo's meta `chartPreviousClose` is the close before the requested RANGE (5d → five sessions back, checked live on INFY.NS), so it is derived from the bars instead. Kite holdings `close_price` feeds it on sync; LTP rows keep the stored value (`coalesce`).

Implementation summary:
    - 11 unit tests in `live.test.ts` (mocked DB/Yahoo/Kite/after; real `refreshLatest`): stale-only, closed skip, claim skip, budget → pending + after, in-flight dedupe, Kite only for Yahoo misses, Yahoo 401 → Kite, disconnected/expired → no call, errors swallowed. Holdings test for the `prev_close` preference; Yahoo tests for spark/chart `prevClose`.
    - Views catch and log every live-refresh error; `HoldingsView.priceAsOf` and `WatchlistView.priceAsOf` give the freshest timestamp for a "Live · updated" label; `marketStatus(now)` for the live indicator.
    - Migration `0011` (additive nullable column) was generated but NOT applied: the auto-mode classifier denied `pnpm db:migrate` against the shared DB. Until it is applied, every query selecting `price_latest` fails.

Follow-ups deferred:
    - Owner applies `pnpm db:migrate`, then reruns the Neon suites.
    - UI wiring (`<LiveRefresh enabled={marketStatus().IN.open || ...} />`, live label) is the UI agent's.
    - A Kite LTP row keeps yesterday's `prev_close` on a day rollover where Yahoo never priced the symbol that day: day change is then off by one session until Yahoo or the next sync writes.

### 2026-11-12 — Kite sync job (U10, Kite part): snapshot qty rule, openings net of today's fills, fills before inference, margins

- Type: feature
- Scope: `src/lib/jobs/kite-sync.ts` + `kite-sync.test.ts`, `src/lib/jobs/registry.ts` (`kite-sync` real, `kite-login` chains it), `src/lib/jobs/handler.ts` (`lastRun`), `src/lib/ledger/ingest.ts` (`bootstrapOpenings(runId, pending)`), `src/lib/mcp/kite/tools.ts` (trade `product`), `src/lib/brokers/connections.ts` (`setStatus` `syncedAt`), `src/db/schema/brokers.ts` + `drizzle/0010_margins_latest.sql`, `src/lib/views/margins.ts` + test, `src/app/(app)/page.tsx` (margins card), `src/app/(app)/settings/brokers/{actions.ts,actions.test.ts,kite-login-button.tsx,page.tsx}`

Reasoning / RCA / research:
    - Snapshot qty = holdings `quantity` (today's sells already out) + `t1_quantity` + today's CNC buys from the `day` positions view; a symbol only in positions gets day buys − day sells at the day buy average. The `day` view, not `net`, so yesterday's buys (now `t1_quantity`) can't be added twice. The U1 note's `max(0, net CNC qty)` and this rule agree on everything observed; they differ only for a same-day buy AND sell of a held symbol, which depends on whether Kite takes the sell from holdings (`used_quantity`) or nets it against today's buy. Unobserved, so held+bought-today rows are counted as `top_ups` in sync_runs for the owner to check.
    - Positions carry no ISIN, so they match holdings by tradingsymbol, summed across exchanges (BSE-held, NSE-sold). Instruments stay keyed (IN, broker_symbol), the same key as the Console import, so both exchanges are one instrument.
    - Bug in the brief's order (bootstrap → fills → inference): `bootstrapOpenings` opened at the snapshot qty, which already includes today's trades, so on first sight held 10 + bought 5 gave opening 15 + fill 5 = 20 vs snapshot 15, then a lag item and later an inferred sell. Fills-first doesn't work either: a same-day sell with no opening yet is an oversell (open review item) and the lag check swallows the residual. Fix: `bootstrapOpenings(runId, pending)` subtracts the run's fills executed before the snapshot, so opening + fills = snapshot. Same-date replay puts openings before sells, so the opening's timestamp needs no change.
    - Exits: the 0-qty row is written for any instrument whose latest earlier Kite snapshot (any run) had qty > 0 and is absent now, rather than "the previous run", so a partial or failed earlier run can't hide an exit. An empty holdings list while shares were held fails the run: far likelier a broker glitch than a full exit (a sale shows as a 0-qty holding that day), and the alternative is inferring a sell of everything.
    - Session: `withKite` already marks `stale`; the sync re-logs in once (`kiteHeadlessLogin`, which marks `login_failed` itself) and retries once. A second expiry fails the run with status left `stale`.
    - Broker LTP goes into `price_latest` with `ON CONFLICT ... WHERE as_of < excluded.as_of`: one statement, and a fresher Yahoo quote is never clobbered. History backfill picks run instruments with no `prices_daily` yet, 5 per run, rather than "created this run": the first sync creates ~30 instruments (range=max each would blow the 300 s budget inside the login job), and the next runs pick up the rest.
    - `kite-login` calls `runJob("kite-sync")` itself, so the sync has its own sync_runs row and banner/staleness logic reads `kite-sync` unchanged. A failed sync does not fail the login (count `sync: failed`).

Implementation summary:
    - Tests: 3 pure (scrubbed U1 fixtures → EEEE 149 under BSE not double-subtracted, CCCC 6, DDDD positions-only 144 @ day avg, 33 lines; T+1 + day buy + MIS/net ignored with weighted avg; same-day round trip and sold-without-holding → 0), 7 Neon (first sync: snapshot 15/5/3/15+t1, openings 10/10/–/15 + fills `fill:<trade_id>`, MIS dropped, BSE exchange kept, no review items, broker LTP and margins; fresher Yahoo price kept; same-day rerun adds nothing; vanished → inferred sell + approximate_sell, fill-explained exit leaves no inferred event even superseded; expiry → one login + retry; second expiry → failed, nothing written; empty holdings guard), 3 margins redaction, 1 action.
    - Mutation checks: inference before fills fails 3 tests; bootstrap without pending fills fails 3.
    - Migration `0010_margins_latest` applied to the dev DB. Full suite 439/439; lint, typecheck and build clean. `tools.test.ts` expects the new trade `product` field.

Follow-ups deferred:
    - No live Kite run in this unit: the owner re-enters creds on prod and presses the buttons. Confirm one `trade_id` against Console; watch `top_ups`.
    - INDmoney sync (U1/U6 INDmoney part). The prices job's MCP quote fallback is still unwired.
    - Instruments get `name = broker symbol`; enrichment (name, sector) is still U8's `enrichInstrument`, not called by the sync.

### 2026-11-12 — Owner "Run automatic login now" on /settings/brokers + unreadable-credentials notice

- Type: feature
- Scope: `src/lib/jobs/handler.ts` (`runJob`, `isRunning`), `src/app/(app)/settings/brokers/{actions.ts,actions.test.ts,kite-login-button.tsx,page.tsx}`, `src/lib/brokers/connections.ts` (`kiteCredentialsReadable`) + test

Reasoning / RCA / research:
    - Purpose: verify the headless chain from a Vercel IP (U7 follow-up) without handing the CRON_SECRET to a browser. The action calls `registry["kite-login"]` through `runJob`, the body of the cron POST extracted unchanged, so the advisory-lock overlap guard, 10-min stuck-run recovery and `redact` apply to both callers. Rejected: having the action fetch `/api/cron/kite-login` with the secret server-side (an extra hop, and the secret would be read in a user-facing path).
    - The action returns `{status, step?}` only. `step` comes from the connection row (`lastErrorStep`, written by `kiteHeadlessLogin`/`withKite`), not from the error text, so nothing beyond the step name crosses to the client; the redacted message stays in `sync_runs.error`.
    - "Already running" uses `isRunning`, which shares the `STALE_AFTER` interval with `runJob`, so the button and the overlap guard agree on what counts as in flight. A double click that races past it gets a `skipped` row and an info toast.
    - `getConnection` never decrypts, so a key mismatch never errored the page; it showed "Set" while the daily job failed at step `login` with a decrypt error. `kiteCredentialsReadable` decrypts all three envelopes and discards them, returning a boolean only. The button is disabled when credentials are unset or unreadable: a run would only flip a working `connected` status to `login_failed`.

Implementation summary:
    - Tests: action (Neon `sync_runs`, access/job/connection mocked) — non-owner → `Forbidden`, job not called, no `kite-login` row; success → completed row with counts; failure → exactly `{status:"failed", step:"twofa"}`, stored error has no password/JWT. Connections (Neon): readable under the saving key, false under another key. Mutation: moving `authorize` after `runJob` fails the non-owner test. Cron route tests (10) pass unchanged against the extracted helper.
    - Full suite 425/425 and build clean; lint and typecheck clean. One earlier full run failed the `connections.test.ts` suite in its `beforeAll` (all 7 tests skipped, cause not captured). Two reruns passed, so this is likely a Neon timeout under parallel load.

Follow-ups deferred:
    - A decrypt failure in `kiteHeadlessLogin` is still attributed to step `login` (hint: "check user ID and password"); the card's re-enter notice covers it for now.

### 2026-11-12 — Kite MCP client + headless daily login (U6 Kite part, U7): allowlisted wrappers, one-attempt chain, state-bound manual reconnect

- Type: feature
- Scope: `src/lib/mcp/client.ts`, `src/lib/mcp/kite/{tools,auth,headless-login}.ts` + tests, `src/lib/brokers/connections.ts` (+ test), `src/app/api/connect/kite/{route,callback/route}.ts` + `callback/route.test.ts`, `src/lib/jobs/registry.ts`, `src/app/(app)/settings/brokers/page.tsx`, `src/lib/views/holdings.test.ts`, `package.json` (`zod` 4.6.7 direct dep)

Reasoning / RCA / research:
    - `withMcp` hands `fn` a `call(tool, args)` that returns `structuredContent` or throws, so `isError` is checked in one place before any parsing. `SessionExpiredError` covers both the 401 path and Kite's `isError` text, because the JWT outlives the Kite session (06:00 IST), so only the server's answer says the session is dead. `withKite` is where that maps to status `stale`. The spike's legacy-protocol fallback was dropped: `versionNegotiation: auto` got 2026-07-28 on the first try, and retrying on any connect error would also retry 401s.
    - Allowlist is `tool → modes` checked in `kiteCall` before the caller runs; `mode` is spread last so args can't override it, and `Object.hasOwn` blocks `constructor`-style tool names. It's the only guard: the hosted server lists order/GTT/alert writes and `session logout` (U1).
    - Zod item schemas list only the fields we map (non-strict objects), so additive server changes pass and renames fail with `tool:mode: schema drift`. `fill_timestamp` must carry an explicit offset, because ingest derives the trade date from it. `zod` was already in the tree (MCP SDK, Better Auth); it is now a direct dependency instead of relying on hoisting.
    - Token expiry is read from the JWT's own `exp` before connecting, with no extra DB query; `token_expires_at` is stored for the UI only. DCR client info is re-registered if it lacks a needed redirect URI or can't be decrypted under this env's key: client_id is public and stateless, so registering again is the whole recovery.
    - Headless chain = spike logic, with each phase wrapped so any throw is attributed to its step (consent|login|twofa|redirect|authorize_app|token). Kite's `/connect/authorize` page gets its own step and hint instead of a generic `redirect`. One login attempt, no retry anywhere. TOTP waits for the next window when ≤2 s remain, then generates.
    - Manual reconnect: POST (form) rather than a GET link, so prefetch or a cross-site GET can't start flows. State binding = sha256 of 32 random bytes in the DB (single-use, 10 min), plus the raw state in an httpOnly SameSite=Lax cookie scoped to `/api/connect/kite`, plus `authorize("manage")` on both routes. Hashing the state with the Better Auth session id was rejected: it needs a second getSession call, and the cookie binds the same browser. `consumeOAuthState` compares with `timingSafeEqual`, then clears with `UPDATE … WHERE hash = <read hash> RETURNING`, so two racing callbacks can't both succeed. An expired state is cleared but never honoured, and a mismatch leaves the pending state alone (an attacker can't cancel the owner's flow).
    - `publicConnectionView` gains `tokenExpiresAt` only. The DB test's "no `token` anywhere in the JSON" check now excludes that key name, not values.

Implementation summary:
    - Tests: client 6 (isError → SessionExpiredError / McpToolError from the recorded error probe, 401, close on throw), tools 10 (every fixture → normalized shapes, 2-page pagination with `from` 0 then 2, empty holdings, allowlist incl. `orders:place` and `session:logout` with zero calls, a renamed field → `portfolio:holdings: schema drift`), headless 8 (fake fetch driven by `headless-chain.json` hops + `mcp-consent.html`: happy path incl. cookie jar and PKCE challenge; login error → no twofa; twofa error → one attempt and the chain stops; authorize_app; extra hop; state mismatch; no creds → no requests; TOTP guard), callback route 10 (missing code/state/cookie, cookie ≠ state, unknown/expired state → 400 with no token request, single use, non-owner 403 before the state is touched, token failure → `login_failed` at `token`), plus 2 Neon tests for client info and the single-use state SQL. Mutation check: disabling the TOTP guard fails the guard test.
    - Full suite 421/421 (before the last test-only typing fixes; the touched files were rerun: 34/34). Lint, typecheck and build are clean.
    - Live (owner-authorized, run once): creds copied from `.env.spike.local` with `setKiteCredentials` (nothing printed), `registry["kite-login"]` ran one headless login plus one `portfolio:profile` read through `withKite` → pass, status `connected`, token 168 h left.

Follow-ups deferred:
    - The live run wrote creds, DCR client and JWT, encrypted with the `.env.local` key, into the Vercel-linked DB. If prod's key differs, prod re-registers DCR on its own (tolerant read), but the owner must re-save the Kite credentials on prod `/settings/brokers`. Prod also needs `APP_URL`.
    - Headless chain from a Vercel IP is still unverified (U1 gate stays provisional). Post-06:00 IST "session expired" text is matched by regex but not yet observed live.
    - `kite-login` should chain `kite-sync` once U10 exists (`ponytail:` note in the registry). The start route has no unit test; its pieces (state save, authorize URL) are covered via the callback and headless tests.
    - INDmoney half of U6 (OAuth provider, refresh lock, scopes).

### 2026-11-12 — U1 spike (Kite part): headless Kite MCP chain proven; gate MCP-first (provisional)

- Type: docs | chore
- Scope: `scripts/spike/kite-headless.mts`, `scripts/spike/scrub.mts`, `docs/spikes/mcp-findings.md`, `src/lib/mcp/__fixtures__/kite-*.json`, `src/lib/mcp/kite/__fixtures__/`, `package.json` (`@modelcontextprotocol/client` 2.4.0, `otplib` 13.6.0)

Reasoning / RCA / research:
    - One Zerodha web login (single attempt, TOTP window guard) drove both the Kite MCP OAuth chain and the Kite Connect redirect through one hand-rolled cookie jar with manual redirects. Every hop is a plain 302/303 with cookies; no listener needed (read `code` off the `Location` to 127.0.0.1).
    - Gate: MCP-first. It gives market data (`ltp`) that Kite Connect Personal lacks, and fills with `trade_id` + `+05:30` timestamps. Rejected switching to Kite Connect REST now: same fields, no market data, and step C was blocked anyway. REST stays the fallback (same login, only the token exchange differs).
    - Provisional because the adopted fix (run the chain from a Vercel function / GitHub runner) is deferred to U7 deploy verification: doing it now means putting credentials in cloud env. Risk: Cloudflare/Zerodha challenges on datacenter IPs.
    - Plan corrections: fills come from `orders` mode `all_trades` (`trades` needs an `order_id`). The hosted server lists write tools (orders place/modify/cancel, gtt, alerts, `session logout`), so U6's `tool:mode` allowlist is the only guard.
    - Ingest semantics found: today's sells are already deducted from holdings `quantity` (`= opening_quantity - used_quantity`); today's buys appear only as net CNC positions; a BSE-listed holding sold on NSE, so match positions by symbol/ISIN, not exchange.
    - The plan says "update Deferred to Implementation in the plan", but `tasks/todo.md` makes the plan body read-only, so the answers live in the findings doc.

Implementation summary:
    - Fixtures are scrubbed by `scrub.mts` (deterministic: symbols → AAAA…, ids format-preserving, PII replaced, numbers fuzzed with quantity relations re-imposed) and it leak-checks every non-ignored file for credentials, the DCR client id, PII and ids (0 hits). Raw output stayed in gitignored `scripts/spike/out/`, deleted after the run.
    - Results: DCR accepted loopback + https in one client; protocol `2026-07-28` negotiated by SDK v2 `mode: "auto"`; JWT `expires_in` 7 d; no authorize screen for the MCP app.

Follow-ups deferred:
    - Step C (Kite Connect Personal) hit Kite's one-time `/connect/authorize` screen; the owner approves it in a browser once, then reruns the spike for `connect-*.json`.
    - Confirm one `trade_id` against the next-day Console tradebook. Verify the post-06:00 IST "kite session has expired" path in U7/U10.
    - INDmoney part of U1.

### 2026-11-12 — A Console CSV row supersedes a manual correction of its fill (U18 follow-up): CSV wins, no double count

- Type: bug
- Scope: `src/lib/ledger/supersede.ts` (`asInferred` → `asOrigin`), `src/lib/ledger/supersede.test.ts`, `src/lib/ledger/manual-correction.test.ts`

Reasoning / RCA / research:
    - Root cause (deferred note in the "Authoritative trades supersede a manual correction of an inferred trade" entry): rule 1 pairs a CSV row with its `fill:<trade_id>` twin among LIVE fills only. After `correctEvent` the fill is superseded and the live head is `manual:<fillId>`, so the Console row matched nothing and both counted (sell → oversell).
    - Precedence (owner-level call by the orchestrator): the Console tradebook is the exchange-confirmed record, so csv > manual correction of a fill. Rejected: linking the CSV row under the manual head (manual > csv), which would keep a hand-typed price over the exchange's.
    - Fix where the inferred case already lives: `asOrigin` walks the same one-predecessor chain; a fill origin of the same type presents the head as `{ source: "fill", sourceRef: <fill's> }`, so rule 1's `tradeKey` finds the CSV twin and supersedes the head. `refRemap` → `REF_COPIERS` then move bucket/watch/journal refs to the CSV buy as for any supersession.
    - Unchanged: a correction of a fill is not replaced by a CSV row with another trade id or by other fills (rule 4 only takes incoming fills); corrections of CSV rows/openings keep manual > csv. Side effect: rule 2 (incoming manual, same date/type) could now replace such a head, as it already could an inferred-origin head; rule 2 has no DB caller.

Implementation summary:
    - Pure tests (2): fill → manual → manual (moved date) → CSV same trade id supersedes the head only, replay qty 5, no anomalies, re-plan no-op; corrected fill buy → `refRemap` manual → csv.
    - DB test (Neon, `TEST_` rows, cleaned up): buy fill 10 (in a bucket) + sell fill 6, both price-corrected, then the Console CSV with both trade ids → `{inserted: 2, superseded: 2}`, live events = the two CSV rows, qty 4, no oversell item, bucket has the CSV buy; re-import `{inserted: 0, superseded: 0}`. Failed before the fix (`superseded: 0`).
    - Mutation check: removing the fill branch in `asOrigin` → those 3 tests fail; restored, all pass.

### 2026-11-12 — Journal hidden from share-link viewers (owner decision): no entries from the loaders, no journal UI

- Type: feature
- Scope: `src/lib/views/journal.ts` (`readsJournal`, `buildEntries`, `getSymbolJournal`, `getWatchJournal`), `src/lib/views/journal.test.ts`, `src/app/(app)/symbol/[id]/page.tsx`

Reasoning / RCA / research:
    - Owner decision: journal text is private to signed-in actors. Share-link viewers (`actor.via === 'share-link'`) get no entries regardless of hide-amounts; signed-in viewers/contributors keep reading them (U20 previously served the text to share links with role labels for authors).
    - Enforced on the server: `buildEntries` (the one path both loaders use) returns `[]` for share links, and both loaders short-circuit before querying. Rejected: CSS/client hiding, which would still ship the bodies in the RSC payload.
    - UI: `getSymbolJournal` returns `visible: false`, and `JournalSection` now owns the `<section>`/heading so the symbol page renders no journal at all. Watchlist's "Journal N" chip already renders nothing for a non-writer with zero entries. "Due for review" was already empty for every viewer (`getDueReviews` requires `suggest`), so no change there.

Implementation summary:
    - Tests: share-link actor (hide-amounts on and off) → `[]`, serialized DTO has no body text; signed-in viewer with hide-amounts → both entries with emails, none editable. Failed before the guard; mutation check (guard removed) fails it again; restored.

Follow-ups deferred:
    - `authorLabel`'s share-link branch is now unreachable from the journal (still used by targets); left as is.

### 2026-11-12 — Journal entries follow a target edit (U20 follow-up): `editTarget` re-points `subject_type='target'` entries to the new target

- Type: bug
- Scope: `src/lib/targets/actions.ts` (`editTarget`), `src/lib/targets/actions.test.ts`

Reasoning / RCA / research:
    - Root cause: edit = insert B + cancel A (`replaced_by`), but journal entries kept `subject_id = A`. `dueReviews` only counts a thesis on the target itself (or on a buy/watch item), so once B resolved, the thesis written on A no longer made it due; the symbol page also tied the thesis to a cancelled call.
    - Fix in the one write path every edit goes through: the same transaction that cancels A moves A's entries to B (soft-deleted ones too, so history stays on one subject). Move, not copy, matching U20's `copyJournalRefs`: the journal is a narrative, a copy would show the thesis twice.
    - Rejected: resolving `replaced_by` chains in `dueReviews` / the journal view at read time. Every reader would need the chain walk; one UPDATE at write time keeps readers simple.

Implementation summary:
    - Test (Neon): thesis on A → edit A → B; the entry's subject is B; B set to hit today → `dueReviews` lists B. Failed before the fix ("expected … to match object { subjectType: 'target', subjectId: B }"); passes after. Mutation check: deleting the UPDATE fails it again; restored.

### 2026-11-12 — Authoritative trades supersede a manual correction of an inferred trade (U18 follow-up): no double count

- Type: bug
- Scope: `src/lib/ledger/supersede.ts` (`asInferred`, `planSupersession`), `src/lib/ledger/supersede.test.ts`, `src/lib/ledger/manual-correction.test.ts`

Reasoning / RCA / research:
    - Root cause: `planSupersession` only matched fills (rule 4) and CSV/US rows (rule 3) against LIVE `source = 'inferred'` events. After `correctEvent`, the inferred event is superseded and the live head is a `manual:<id>` event, so a later fill/CSV row for the same trade matched nothing: both counted, and replay raised an oversell item. Precedence now: fill/csv/us_history > manual correction of an inferred trade > inferred.
    - Fix in the planner, which both `ingestFills` and the CSV/US imports route through (`writeWithSupersession`), so no ingest change: a live manual event whose chain (manual → … → manual, one predecessor per step via prior links) starts at an inferred buy/sell of the same type is presented to rules 3/4 as an inferred event, anchored on the inferred event's date and snapshot time. The link then targets the manual head, and `refRemap` → `REF_COPIERS` move bucket memberships / watch links / journal refs onto the fill or CSV buy as for any supersession.
    - Anchoring on the inferred snapshot, not the owner's corrected date: a fill is matched as "executed up to 5 days before the snapshot that revealed it". A date moved to the real trade day has no `executedAt` (midnight UTC), so a same-day fill would fall outside the window.
    - Partial fill of a corrected trade: the `:rem` remainder keeps the owner's price, is dated/anchored at the snapshot, `approximate` with source `inferred`, so a later fill can still cover it.
    - Corrections NOT originating from an inferred trade keep current behavior (checked, pinned by a test): a manual correction of a fill/CSV row is not replaced by other fills or imports; a manual correction of an opening is still replaced by CSV buys (rule 3's opening branch never checked source); `reclassifyAsBonus`'s manual bonus (origin: split) is untouched. Rule 2 (incoming manual) has no DB caller (`correctEvent` builds its own link).
    - Rejected: walking the chain in `ingest.ts` and rewriting links after planning. The planner already owns matching and `refRemap`; a second pass would duplicate the window rules.

Implementation summary:
    - Pure tests (6): fill supersedes the manual head, replay qty 5 and no anomalies, re-plan no-op; corrected inferred buy → `refRemap` manual → fill; moved date + manual-of-manual chain resolves to the head; CSV row in range supersedes the head; partial fill leaves a 3-share remainder at the owner's price; a manual correction of a fill is not replaced by a CSV row or another fill.
    - DB tests (2, Neon, `TEST_` rows, cleaned up): inferred buy (in a bucket) and inferred sell, both price-corrected, then the broker fills → each manual superseded by its fill, replay qty 9 = snapshot, no oversell item, bucket membership on the fill buy, re-sending fills `{inserted: 0, superseded: 0}`; same with a Console CSV sell → `{inserted: 1, superseded: 1}`, qty 4, re-import no-op.
    - Mutation check: `live` back to `liveEvents(existing, prior)` → 7 tests fail (5 pure, both DB; the CSV import then inserts a reconcile opening: `inserted: 2, superseded: 0`); restored, all pass.

Follow-ups deferred:
    - Found by reading rule 1, not fixed (out of scope, behavior kept): a manual correction of a FILL followed by the Console CSV row for the same trade id still double counts. Rule 1 (CSV beats its fill twin) only sees live fills. Fix: when the fill twin is superseded by a manual head, link the CSV row under that head (manual > csv) or let the CSV supersede it, per the owner's call on precedence. RESOLVED 2026-11-12: the CSV supersedes the head of the correction chain (entry "A Console CSV row supersedes a manual correction of its fill").

### 2026-11-12 — Export (U21): CSV/XLSX from the page view builders, formula-injection guard, route-level 401/403

- Type: feature
- Scope: `src/lib/export/{sanitize,sheets,csv,xlsx}.ts` + `xlsx.test.ts`, `src/app/api/export/[kind]/route.ts` + `route.test.ts`, `src/lib/views/trades.ts` (`buildTrades` optional `cap`), `src/components/export-menu.tsx`, headers of `src/app/(app)/{holdings,buckets,trades,ledger}/page.tsx`, `package.json` (`exceljs` 4.4.0)

Reasoning / RCA / research:
    - Exports call the pages' own loaders and pure builders (`loadHoldingsInputs` + `buildHoldingsView`, `buildBucketsView`, `buildTrades`), then flatten the DTO into a format-neutral `Sheet`. Redaction and numbers therefore match the pages by construction; a separate export query was rejected (two money paths drift). A column flagged as an amount is dropped whole for hide-amounts actors, never blanked, and the DTO already lacks the field anyway.
    - Hide-amounts (adopted fix): drops Qty, Invested, Value, P&L (holdings), money columns (buckets), Qty (trades) and every amount row of the Summary; keeps Avg Cost, LTP, Return %, Day %, Weight %, and the market weights. Weight % is included because it is what the page shows viewers instead of Value.
    - Formula injection (adopted fix): every string cell starting with `= + - @ tab CR` gets a leading `'` in both formats. In XLSX the value is also a plain JS string, which exceljs always writes as a string cell (formulas only come from an explicit `{ formula }` object); numbers stay numeric, so a negative P&L is still a number, not `'-250`.
    - Route uses `getActor()`, not `requireActor()`: a redirect to /sign-in is wrong for a download, and proxy skips `/api` anyway. Denied (signed out, dead link, expired grant) → 401 JSON; ledger for a non-owner → 403 (also re-checked inside `exportSheets`). `Cache-Control: private, no-store` because the body is portfolio data.
    - Amount columns are INR (`Invested (INR)` etc.) so the rows sum to the Summary totals; a `Currency` column was added next to Exchange because Avg Cost and LTP are native. Return % uses the INR return for US rows, matching the page's default INR view. Percentages are fractions with a `0.00%` format in XLSX and percent numbers (12.5) in CSV; dates are real date cells.
    - Trades export lifts the page's 400-row display cap (`buildTrades(..., cap = Infinity)`); the page default is unchanged. Ledger export = every event, superseded included, with status, "replaced by", source ref, FX rate and event id.
    - CSV is the first sheet only (the Summary is XLSX only), RFC 4180 with CRLF and a UTF-8 BOM so Excel reads ₹ and non-ASCII names.

Implementation summary:
    - Tests: `xlsx.test.ts` (5, pure): holdings XLSX columns + Summary invested/value/P&L/return/India/US/FX equal the view totals and the Value column sums to the total, no formula cells; hide-amounts → no Qty/Invested/Value/P&L columns or amount rows, prices and % present (XLSX and CSV header); bucket name `=HYPERLINK("http://x","y")` and description `+cmd|' /C calc'!A0` are string cells with a leading quote in XLSX (buckets sheet and the holdings Buckets column) and inert in CSV, negative P&L stays a number; CSV quoting of commas/quotes/newlines. `route.test.ts` (4, mocked actor): signed out / dead link / expired → 401 JSON with nothing loaded; viewer and contributor ledger → 403; owner ledger CSV filename `stockboard-ledger-YYYY-MM-DD.csv`, no-store, inert cell; viewer holdings XLSX 200, unknown kind 404, bad format 400.
    - Mutation check: `neutralize` as identity fails 3 tests (XLSX, CSV, route); restored.
    - Full suite 372/372; lint, typecheck clean; `next build` clean (`ƒ /api/export/[kind]`).
    - Manual check (`next start -p 3021`, existing demo seed + scratch owner session, hide-amounts share link and a hostile-name bucket on a DEMO buy): curl downloads of holdings/buckets/trades/ledger in both formats (200, dated filenames). A scratch exceljs script recomputed the holdings view: Summary invested 990,615.96 / value 1,278,362.57 / P&L / return 29.05% / India / US match, Value column sums to the total, 0 formula cells in all five workbooks, hostile cells are string type with a leading quote. Share-link viewer: holdings XLSX/CSV without amount columns or amount Summary rows, same return %; viewer ledger 403, anonymous 401. Export menu checked at 1440/375 light/dark on all four pages (no horizontal scroll, no console errors).
    - Gotcha during the check: the concurrent U20 run rebuilt `.next` under the running server (stale client chunks → 500s, menu would not open) and its DB cleanup removed the shared owner user/session; restarted the server and re-created a scratch session. All scratch rows (session, user, share link, bucket) and the demo seed were removed afterwards; benchmark and FX rows untouched.

Follow-ups deferred:
    - Trades export ignores the page's market/type/history filters (exports all live trades); pass the page's query through if filtered exports are wanted.
    - Holdings export is the whole portfolio, not the current market/bucket tab. The Export button is hidden on the empty Holdings state and Buckets with no buckets, shown on empty Trades/Ledger (header-only file).

### 2026-11-12 — Trade journal (U20): polymorphic entries, journal moves (not copies) on supersession, Due for review on Overview and Targets

- Type: feature
- Scope: `src/db/schema/journal.ts`, `drizzle/0009_journal.sql`, `src/lib/journal/{kinds,actions,due-reviews}.ts` + `actions.test.ts`, `due-reviews.test.ts`, `src/lib/views/journal.ts` + `journal.test.ts`, `src/lib/ledger/ingest.ts` (`REF_COPIERS` entry), `src/app/(app)/symbol/[id]/{page,journal,journal-actions}.tsx`, `src/app/(app)/{page,watchlist/page,targets/page}.tsx`, `src/app/(app)/targets/editor.tsx` (export `Toggle`)

Reasoning / RCA / research:
    - `subject_id` has no FK (three subject tables); `createEntry` checks the subject exists and copies its `instrument_id` onto the row, so the symbol page and the due check read one index instead of a three-way union. A buy subject must be a live buy/opening (`MEMBER_EVENT_TYPES`, same rule as buckets); writing on a replaced event is refused with "reload and pick it again".
    - Supersession MOVES entries to the first superseding buy/opening by date (same ordering as `copyWatchLinks`), unlike `copyBucketMembers` which copies to every one. A thesis copied onto three CSV buys would show three times in the timeline and could not be edited once. No buy among the superseding events → entries stay put (still listed, labelled "(replaced)").
    - Permissions per the resource-owner rule: create = suggest (owner, contributor), author always the actor's email (`authorEmail` reused from watch actions); edit/delete = edit_own on `author`; delete is soft (`deleted_at`) so a review can't silently vanish from history. Viewers get no composer, no menus, no Due card, no review links (UI), and the actions refuse them anyway.
    - Due for review: resolution day = `resolved_at`, or the passed deadline of a still-pending target (the nightly job expires it a day later; the owner shouldn't wait for that). Window 0-7 days in the target's market zone, so "8 days ago" drops out. A thesis counts on the target itself or on any buy/watch item of the same instrument, not on a different target (that thesis is about another call). A review counts only on that target and only if written on/after the resolution day: a mid-flight review is about the open call, not the outcome.
    - Kinds/limits live in a client-safe `kinds.ts` that the pgEnums are built from: the client composer needs the 4000 cap and the kind list, and importing the schema would pull drizzle into the client bundle. The schema imports it relatively because drizzle-kit doesn't resolve `@/` aliases.
    - Journal text is shown to hide-amounts viewers (it is not an amount). Share-link viewers see "Owner"/"Contributor" via the targets `authorLabel`, never emails (asserted in `journal.test.ts` and in the browser HTML).
    - Gotchas: `getDueReviews(now = new Date())` broke `next build` ("blocking-prerender-current-time") because the default parameter runs before `requireActor()`'s `connection()`; `new Date()` now comes after it. React's `autoFocus` isn't applied to server-rendered fields on hydration, so the review composer focuses in an effect.

Implementation summary:
    - Tests: due-reviews (pure, 6): expired yesterday + thesis + no review → due with outcome/miss %; review after resolution → gone (another target's review, a note, a pre-resolution review don't count); 8 days → not due, 7 → due; no thesis / other instrument / note → not due; thesis on target or watch item counts, on another target doesn't; hit has no miss %, pending past deadline reads expired, cancelled/open never. Actions (Neon, 4): viewer rejected, missing subject and blank body refused; contributor entry attributed with instrument filled; contributor can't edit/delete the owner's entry, can edit/delete own, owner can edit theirs (author kept), soft delete then edit refused; opening superseded by Console CSV → the thesis moves to the 15 Jan 2024 CSV buy, one row, and a new entry on the replaced opening is refused. View (pure, 2): share-link roles without any "@", contributor edit flags, edited flag. Full suite 372/372; lint, typecheck, build clean.
    - Mutation check: removing `copyJournalRefs` from `REF_COPIERS` fails the supersession test; restored.
    - Migration `0009_journal` generated and applied to the dev DB; a re-generate reports no drift.
    - Browser check (scratch seed on `pnpm demo:seed`: temporary owner session + hide-amounts share link, an expired INFY target with a thesis on the buy and a contributor note, a hit HDFCBANK target with a thesis on the target, an ITC watch item with a thesis; `next build` + `next start -p 3001`): Overview Due card, symbol journal with the `?review=` prefill, targets history "Write review", watchlist sheet at 1440/375 light/dark; no horizontal scroll, no console errors. Writing the review removed INFY from the Due card and left HDFCBANK; inline edit saved; a note from the watchlist sheet saved. Viewer: no emails in HTML, no composer/menus/Due card/review links, "Owner"/"Contributor" shown. Scratch rows, session, user, share link removed (all 0); real benchmark/FX rows untouched.

Follow-ups deferred:
    - Open question for the owner: thesis text is visible to share-link viewers (kept visible, per the brief). Hide it from share links if theses may name private reasons.
    - Entries on a target are not re-pointed when a target is edited (edit = new row + old cancelled); the old target's thesis no longer makes the new one "due". Move them in `editTarget` if that matters.
    - The Overview card only renders when holdings exist (the empty-portfolio branch returns early).

### 2026-11-12 — Target levels rebased for later splits/bonuses in buildTargetsView (U19 follow-up): Holdings Upside, Targets "to go", watchlist chips and symbol page agree

- Type: bug fix
- Scope: `src/lib/targets/evaluate.ts` (`factorAfter`, now shared), `src/lib/views/targets.ts` (`buildRow`, `loadTargetsInputs`, `getTargetMarks`) + `targets.test.ts`, `src/lib/views/symbol.ts` + `symbol.test.ts`, `src/app/(app)/targets/page.tsx` (LevelCell)

Reasoning / RCA / research:
    - Root cause: targets store `price` raw on the set date's basis (U16, ADR 0005). `evaluate()` rebased it per bar, but `buildRow` and `getTargetMarks` compared the stored level with today's LTP, so a target set before a split/bonus read as e.g. +113% instead of ~+7%. U19 fixed it only inside `buildSymbolView`, which left Holdings, Targets and Watchlist wrong and the rule in two places.
    - Fix at the one place every caller routes through: `buildRow` computes the effective level (stored ÷ product of ratios with ex-date in (set date, today]) for pending rows; `price` is that level, `setPrice` the stored one when it moved. `getTargetMarks` now builds marks from `buildTargetsView(...).active` instead of its own raw query, so Holdings Upside and the watchlist chips use the same rows. `buildSymbolView` drops its own adjustment (it would now double-adjust) and passes the rows through.
    - One helper: `factorAfter(date, splits, upTo?)` moved from `symbol.ts` to `evaluate.ts` (client-safe, already the home of `Split`) and `evaluate()` uses it too, so the evaluator, the views and the chart share one rule. Upper bound `today` for target levels: an action dated after today must not move a level the LTP hasn't moved yet (evaluate bounds by the bar date the same way).
    - Resolved/cancelled rows keep the stored level: `resolvedPrice` is raw on the resolve day and `bestPrice` is on the set basis, so rebasing history to today's basis would mix three bases. Not changed.
    - Rejected: adjusting in each page (Holdings, Targets, Watchlist) — three copies of the rule, the bug class U19 already showed. Rejected: storing a rebased price on split ingest — mutates history and fights the immutable-target rule.
    - `buckets.ts` keeps its own `splitFactorAfter` (splits only, for dividend per-share rebasing): different semantics, not touched.

Implementation summary:
    - Tests (`targets.test.ts`, pure): 1500 set before a 2:1 split, LTP 780 → 750 and −3.85% (not +92%), marks give 750; 1:1 bonus (stored 2:1) same; no action / action before or on the set date / after today → unchanged, `setPrice` null; 2:1 + bonus compound to 375 with an earlier action ignored. `symbol.test.ts` now feeds pre-adjusted rows (as `buildTargetsView` hands them).
    - Mutation check: `buildRow` back to `t.price` → 3 of the 4 new tests fail (split, bonus, compound; the no-action control passes either way); restored, 9/9.
    - Targets page LevelCell shows "set as X before a split" when moved; Holdings stays compact (Upside % only).

Follow-ups deferred:
    - `getTargetMarks` now loads history rows and the "New target" options too (`ponytail:` note); add a pending-only loader if the targets table grows large.
    - Symbol page distance now uses `price_latest` like every other page; without one (close fallback) the targets list shows no distance.

### 2026-11-12 — History, trades and ledger views (U18): history derived on read, time-weighted index for hidden amounts, exact-target manual corrections

- Type: feature
- Scope: `src/lib/views/{history,trades,ledger}.ts` + `history.test.ts`, `trades.test.ts`, `src/lib/ledger/ingest.ts` (`correctEvent`, `reclassifyAsBonus`, `resolveReviewItem`) + `manual-correction.test.ts`, `src/app/(app)/{history,trades,ledger}/page.tsx`, `src/app/(app)/ledger/{actions,forms}.tsx`, `src/components/charts/{value-area,pnl-heatmap}.tsx`, `src/components/source-badge.tsx`, `src/components/shell/nav.tsx` (drop "Soon" on Trades/History, owner-only Ledger under Settings)

Reasoning / RCA / research:
    - History is computed on read (U17 decision): per instrument, one FIFO replay per distinct event date gives a step function of (qty, invested), then a single pointer walk over the day axis multiplies by the raw close and the U11a `pendingFactor` (actions not yet credited). Cost is O(days × instruments) + O(events²) per instrument, never O(days × events); 3y × 50 instruments builds inside the test's 200 ms budget (the whole 8-test file runs in about 30 ms of test time).
    - Day axis = dates on which some in-scope instrument has a stored close. Weekends and joint holidays are gaps, never zero points; an instrument without a close that day (its own market's holiday) carries its last close, so ALL never dips on an IN-only holiday. Flows dated on a non-axis day land on the next point. An instrument with no close stored yet is held at cost, not zero (it jumps when its first close arrives; better than a fake 100% loss).
    - Day P&L = value change − net flow (buys and openings in, sells and dividends out). The % divides by previous value plus the day's net inflow, so a first-buy day isn't a division by zero and a big buy doesn't inflate the day's %. Openings count as inflows, else the first sync would read as a giant gain.
    - Hide-amounts (adopted fix "redacted/normalized series"): the series is a time-weighted index (100 at the range start, compounding day %), not value ÷ first value, which buys and sales would distort. `HISTORY_POINT_POLICY` / `HISTORY_SUMMARY_POLICY` drop value, invested, flow, day P&L and summary amounts; asserted on the JSON. Trades keep symbol, side, date, price and source and drop qty and amounts (`TRADE_POLICY`).
    - Corrections build the supersession link to exactly the chosen event (`manual:<eventId>`), not via `planSupersession`'s manual rule: that rule replaces every same-type event on the manual event's date, so it would also drop a second trade that day and miss the original when the date moves. Everything else reuses ingest: global ledger lock, `commit` (so `REF_COPIERS` copy bucket/watch refs onto a corrected buy), `flagOversells`; open review items whose `detail.eventId` is the corrected event are resolved in the same transaction.
    - Split → bonus = flip `corporate_actions.kind` (+ `confirmed_by_owner`) and, if the ledger already credited the split, supersede it with a `manual` bonus of the same ratio/ex-date/allotment date (U11a made this a type change). "Ignored" vs "resolved" lives in `detail.resolution`: no migration needed.
    - Ledger page success feedback is a toast: the resolved item / replaced entry re-renders without its form, so an inline "Saved" unmounted before anyone saw it (found in the browser pass). Errors stay inline.
    - Heatmap: fixed |day %| thresholds (0.5/1/2%) so the legend can name them; gain/loss palette tokens via `color-mix`, so the colorblind palette applies; ▲/▼ glyph in every cell; one tab stop with roving focus (up/down = trading day, left/right = week, Home/End), tooltip on focus and hover, full `aria-label` per cell. Ranges over a year render one grid per calendar year.

Implementation summary:
    - Tests: history (pure, 8): 1Y ordered and inside the range, weekends absent, index starts 100; IN holiday carries the last close in ALL and is a gap in IN; buy day +50 not +1100, sell day −20, FIFO invested; US at daily FX with weekend carry (FX move = day P&L); uncredited split shows no drop; hide-amounts index [100, 105, 102.9] and no amount keys in JSON; empty; 3y × 50 perf. Trades (pure, 4): superseded hidden by default and counted, history toggle marks "replaced by manual", market/type filters, redaction. Manual correction (Neon, 4): inferred sell 120 → 130 supersedes, realized 120 → 180, approximate_sell item resolved, contributor refused with nothing written, replaced event refused; corrected buy carries the bucket membership and bucket realized = 240; date move; split → bonus gives lots [10 @ 100 from 2 Feb, 10 @ 0 from 11 Feb] and the CA row flipped; resolve/ignore owner-only and once.
    - Mutation checks: dropping the flow term fails the cash-flow test; dropping the pending factor fails the split test; restored.
    - Browser pass (scratch seed `DEMOH_*` with a year of synthetic closes, no sync runs so other views are untouched; temp owner session + hide-amounts share link; `next build` + `next start -p 3001` because Next 16 allows one `next dev` per directory and U19's held it): history/trades/ledger at 1440/375 light/dark, heatmap keyboard (ArrowLeft moved a week, tooltip shown), chart hover, trades history toggle, UI correction and bonus reclassification persisted. Viewer: index chart only, no amount keys or labels in HTML, `/ledger` shows "Owner only" and no nav link. Fixed during the pass: a sr-only `<caption>` escaped the table's scroll box at 375 (absolute child of a non-positioned overflow container), heatmap weekday labels were scrolled out of view. Scratch rows, session and share link removed (0 left).

Follow-ups deferred:
    - A `manual` correction of an inferred trade isn't superseded by a later tradebook/fill for the same trade (precedence manual > csv/fill), so both count and an oversell item is raised. Teach `planSupersession` that imports may replace a manual event whose predecessor was inferred if this happens in practice.
    - History stops at the last stored close (no intraday point for today). Trades feed shows the newest 400 entries (`ponytail:` note); add paging when needed.

### 2026-11-12 — Allocation, symbol page and news (U19): weights reused from Holdings, chart on today's share basis, owner preferences in `settings`

- Type: feature
- Scope: `src/lib/views/{allocation,symbol}.ts` + tests, `src/lib/market/market-cap.ts` + test, `src/lib/market/news.ts` (+test: `getSymbolNews`, `newsQueryName`), `src/lib/settings/preferences.ts`, `src/lib/views/targets.ts` (optional instrument filter on `loadTargetsInputs`), `src/app/(app)/allocation/{page,actions,controls}.tsx`, `src/app/(app)/symbol/[id]/page.tsx`, `src/app/(app)/settings/preferences/{page,actions,form}.tsx`, `src/components/charts/{weight-bars,price-chart}.tsx`, `src/components/shell/nav.tsx`, symbol links in `src/app/(app)/{holdings,watchlist,targets}/page.tsx` and `buckets/[id]/page.tsx`

Reasoning / RCA / research:
    - Allocation reuses `loadHoldingsInputs` + `buildHoldingsView` and only reads `weightPct`, so its weights equal the Holdings page by construction and the pure builder never sees an amount (hide-amounts viewers get the same view; asserted on the JSON). A separate value query was rejected: two weight computations drift.
    - Preferences live in the existing `settings` key/value table (`concentration_stock_pct`, `concentration_sector_pct`, `market_cap_thresholds` in native units, `india_dividend_tds` as a fraction, the format `dividendWithholding()` already reads). No migration, so no journal clash with U18; a malformed value falls back to its default per key.
    - Market-cap buckets: India approximates SEBI's rank cut-offs with absolute ₹ thresholds (rank data isn't available from Yahoo). ETFs have no cap and land in "Unknown".
    - Unclassified is its own group, always last, never a sector warning. The owner override sets `sector_overridden`, which `enrichInstrument` already respects. "Enrich missing sectors" does 8 per click with a pause and in random order, because names Yahoo can't classify (ETFs) would otherwise take the same slots on every click.
    - Symbol chart: raw closes, trades, watch prices and target levels are each divided by the factor of corporate actions after their own date, so one chart is on today's basis (the ex-date bar and ex-date trades are already post-split, matching replay). Day change uses the adjusted previous close, so it doesn't share Holdings' known split jump.
    - Targets on the symbol page show the level and distance on today's basis, with the stored level as "set as X before a split". `getTargetMarks()` was not used for the chart levels: it loads every instrument and returns raw stored prices; `nearestMarks` on this instrument's adjusted rows gives the same "nearest" rule.
    - Lots: hide-amounts drops qty, cost per share and invested (dates and % only, per the unit brief), although Holdings keeps avg cost for viewers; the position-level FIFO avg stays, matching Holdings. Kite's weighted average comes from the latest snapshot `avg_price` and shows next to the FIFO avg with a tooltip explaining why they differ after a partial sale (orchestrator note).
    - News: `getSymbolNews` is `'use cache'` + `cacheLife('hours')` keyed by (symbol, market, name), reads no cookies, and throws out of the cache scope on failure so errors aren't cached. The quoted query drops legal suffixes and parentheticals ("Apple Inc." → "Apple"), else "Infosys Limited" in quotes misses most headlines.
    - Gotcha: a `sr-only` `<table>` still sizes to its content and widened the page by 12 px at 375; the class now sits on a wrapper div. The bars' limit line drifted per row while the label and value columns were content-sized; fixed column widths line it up.

Implementation summary:
    - Tests: allocation (6, pure): 40% stock at a 20% limit → warning naming it with weight; sector over limit without any stock over; missing sector → Unclassified with weight kept, listed, no sector warning; market and cap grouping, unpriced counted not weighted; hide-amounts deep-equals the owner's view minus flags, no amount keys; empty. market-cap (5). symbol (8, pure): 2:1 split → closes, buy/sell/watch markers and target levels on today's basis, ex-date factor, range limits with a pre-range previous close, LTCG dates IN 12 / US 24 months, FIFO vs broker avg, hide-amounts lot/marker redaction, snapshot-only fallback lot. news query name (1). Full suite 347/347; lint, typecheck, build clean.
    - Mutation check: removing the corporate-action factor from the chart fails the split test; restored.
    - Browser check (scratch scripts, port 3000, temporary owner session + hide-amounts share link; `pnpm demo:seed` + scratch sectors, caps, synthetic history, a 1:1 bonus on HDFCBANK, an extra buy and partial sell on INFY, watch items, targets, a bucket): allocation and symbol pages (IN and US) at 1440/375 light/dark, no horizontal scroll, no console errors. Real Google News rendered 8 headlines for Infosys and Apple. Symbol links from holdings, watchlist, targets and a bucket member reach `/symbol/[id]`; sector override persisted with `sector_overridden`; a 10% stock limit added warnings; an invalid cap threshold showed its inline error. Viewer HTML had no qty/cost/invested keys, no owner controls, no emails. All demo and scratch rows, settings keys, session and link removed afterwards (verified 0).

Follow-ups deferred:
    - Holdings Upside and the Targets page "to go" still compare the stored (raw) level with today's price, so a target set before a split reads wrong there (U16 behavior; the symbol page adjusts). Fix in `buildTargetsView`/`getTargetMarks` by loading corporate actions.
    - The FIFO-vs-Kite avg tooltip is on the symbol page only; the Holdings column has no room for it (U16 measured the table at its width limit).
    - Chart downsampling is plain every-nth above 600 points (`ponytail:` note); markers have native SVG `<title>` hovers, not the shadcn tooltip.
    - Journal slot is a placeholder for U20.

### 2026-11-11 — EOD pipeline (U17): per-market EOD, resumable backfill, prices-intraday wired; Yahoo range=max returned monthly bars

- Type: feature + bug
- Scope: `src/lib/jobs/{eod,backfill,prices-intraday,registry,handler}.ts` + `{eod,backfill,prices-intraday}.test.ts`, `src/app/api/cron/[job]/route.test.ts` (holiday case), `src/db/schema/{ledger,ops}.ts`, `drizzle/0008_eod_dividends.sql`, `src/lib/market/yahoo.ts` (+ `yahoo.test.ts`, `prices.test.ts`), `src/lib/returns/benchmark.ts` (+test), `src/lib/views/buckets.ts` (+test)

Reasoning / RCA / research:
    - Bug (U8): Yahoo `chart?range=max&interval=1d` silently returns MONTHLY bars dated the 1st (live: SPY 407 bars since 1993 vs 8,505 with an explicit period). Every `range: "max"` caller (backfill, U8's refetch-on-new-event, ingest's split fetch) would have written monthly OHLC over daily rows. Fixed once in `chart()`: "max" becomes `period1=0`. The polluted benchmark rows from the first live run were deleted and re-backfilled.
    - No `portfolio_values` table (scope decision overriding the plan): portfolio history is derived on read in U18 from the ledger, raw closes and FX, so a ledger correction or late split never leaves stale derived rows. The plan's holiday rule ("skip values") therefore becomes: no bar for today → run status `holiday`, skip dividends, re-pricing and targets.
    - EOD order: bars (Yahoo 5d chart via U8 `backfillHistory`) → FX → holiday check → dividends → re-price → targets. FX runs before the holiday check because ECB and exchange holidays differ. Every bar fetch failing throws (Yahoo down ≠ holiday); some failing is counted.
    - Idempotent per (market, date): bars upsert, dividend events dedupe on `div:<instrumentId>:<exDate>`, re-pricing resolves its review item, the target evaluator writes only changes. Dividends with ex-date in the last 10 days are rechecked, so a late Yahoo event still lands.
    - Dividends net (owner decision): `price` = net per share, plus nullable `gross_amount` and `withholding_rate` columns (two typed columns instead of a jsonb detail column). Qty = `heldQtyOn` from ledger replay, divided by ledger splits after the ex-date and multiplied by actions not yet credited (`pendingFactor`), so qty and the stored per-share are both on the ex-date's raw basis (U12 note). Source `action` (already in the DB enum). fx = pay date's rate, else ex-date's.
    - Re-pricing approximate inferred sells uses supersession, not an UPDATE (ADR-0005): new event `<ref>:close` with source `inferred`, so a later broker fill still supersedes it. Source `manual` was rejected for that reason (fills never supersede manual). Ref copiers run on it (U20 journal refs may sit on sells). `price_fallback` items are left alone: they are buy-side (implied cost fell back to the broker avg), and a close is not the right cost.
    - Tracked set = latest-snapshot qty > 0 ∪ open ledger lots ∪ active watch items ∪ pending targets ∪ benchmarks. Open ledger lots were added to the spec's snapshot rule so CSV-only holdings (no broker sync yet) still get prices and dividends. Backfill also includes anything with ledger events, because sold positions need history for U18.
    - Backfill uses full history for every instrument rather than "from the first ledger date": it covers that range, and U8 would refetch everything anyway once a partial fetch found an unstored dividend, which a first backfill always does. FX comes from the earliest ledger date, or 5 years back, in the first chunk only. Chunks are 10 instruments, cursor `{after: id}` in id order, and a failed chunk is retried from the last completed cursor.
    - Bonus lots in buckets (orchestrator note): `bonusSlices` gives each member lot a pro-rata slice of every later bonus lot (by qty held at its ex-date, chained through earlier slices, including the slice's share of later sales). It is wired in the bucket loader and the pure builder (value, realized, chart). A per-lot bonus in replay was rejected as a larger change to the ledger core.
    - Benchmark dividends are reinvested net of the same withholding (`IndexSeries.withholdingRate`), so alpha is like for like. `dividendWithholding()` was extracted from the bucket loader and is shared with EOD.
    - Jobs return `counts` values that may be strings (`{skipped: "IN closed"}`, `{blocked: "awaiting broker integration"}`) and an optional `status: "holiday"` that the handler stores.

Implementation summary:
    - Tests (Neon, mocked network, TEST_ instruments in 2003, `only` scope so real benchmarks are never touched; `refreshFx`/`ensureFxRange` mocked where they would overwrite real fx_daily): EOD 6 (IN net 4.5/gross 500 at 10%, US 0.75/gross 10 at 25% with ex-date FX, bought-after-ex → none, re-run no duplicates, target hit from the same run's bar, approximate sell → `:close` at 97.5 with link + item resolved + re-run no-op, Independence Day → holiday with nothing written). Backfill 1 (5 instruments, chunks of 2, interrupted chunk 2 resumes from chunk 1's cursor, benchmark and sold position included, FX from the earliest ledger date once). Intraday 3 (tracked set incl. snapshot/ledger/watch/target/benchmark, excl. archived/sold/none; weekend → no fetch; IN open/US closed). Bucket bonus (pure), benchmark withholding, route holiday status. Full suite 311/311; lint, typecheck, build clean.
    - Mutation check: disabling the holiday return fails the holiday test; restored.
    - Live (dev DB, benchmarks only, one chunk, 14 s): NIFTYBEES.NS 4,401 bars 2009-01-02 → 2026-11-11 (0 dividends); SPY 8,505 bars 1993-01-29 → 2026-11-11 (136 dividends); fx_daily 1,826 rows 2021-11-12 → 2026-11-11. A synthetic bucket on that real data: IN alpha +1.22%/yr (Nifty TR 9.85%), US alpha −10.03%/yr (S&P in INR 24.69%), no longer "Benchmark pending".
    - Migration `0008_eod_dividends` applied to the dev DB.

Follow-ups deferred:
    - Yahoo NIFTYBEES data: no split event for the Dec 2019 1:10 unit split (the series is already back-adjusted, so it is continuous), but the 2019-12-19 and 2019-12-20 bars are 10x low (~13 vs ~129). This only matters for flows on those two days. Fix with an owner price override if it bites.
    - Only the newest open `approximate_sell` per instrument is re-priced (the review queue keeps one open item per (instrument, kind)). Older approximate sells stay at the quote price.
    - Dividend ledger events cover the last 10 days only. Historical ones are not backfilled (views compute dividends from the `dividends` table, so the numbers are unaffected).
    - Holdings `?bucket=` doesn't follow bonus-only remainders (parent lot fully sold). The bonus pro-rata is skewed across a later split if a lot was fully sold before it (`ponytail:` note).
    - Backfill chunk is a fixed 10 instruments; add a time budget if a chunk approaches 300 s.

### 2026-11-11 — Targets and manager scorecard (U16): raw-basis levels, edit-as-replace, one-transaction evaluator, Upside on holdings

- Type: feature
- Scope: `src/db/schema/targets.ts`, `drizzle/0007_targets.sql`, `src/lib/targets/{evaluate,scorecard,actions,evaluate-job}.ts` + tests, `src/lib/views/targets.ts` + test, `src/lib/views/holdings.ts` (`latestSnapshotRunIds` extracted), `src/app/(app)/targets/{page,actions,editor}.tsx`, `src/app/(app)/holdings/page.tsx` (Upside column), `src/app/(app)/watchlist/page.tsx` (target chips), `src/components/shell/nav.tsx` (drop "Soon")

Reasoning / RCA / research:
    - Levels are stored absolute on the raw basis of the set date and never rewritten; a later split (or bonus: both rescale the raw price) divides the threshold per bar by the cumulative ratio between the set date and that bar. best_price is converted back to the set basis so miss % compares like with like. Rewriting the stored price on each split was rejected: a late-reported split would silently change a manager's call.
    - Only bars strictly after the set date count: the set day's high/low may predate the call (a target set below an intraday high would resolve instantly). Cost: a target set before the open and hit that same day resolves a day late; acceptable for an EOD lifecycle.
    - Expiry needs `asOf > deadline`, not just "no more bars", so a holiday on the deadline still expires the next run and a deadline-day hit always wins. resolved_at for an expiry is the deadline itself, so days-to-resolve is calendar-honest.
    - Edit = insert new + cancel old with replaced_by, guarded `where status = 'pending'` inside one transaction; if the EOD run resolved it meanwhile the edit is rolled back with a clear error. The new row is stamped with the editor (owner editing a manager's call makes it the owner's call); the original stays in history and is not scored. set_by is never read from input.
    - % mode converts against price_latest (what the user saw), falling back to an on-demand quote; the editor's live preview runs the same pure `priceFromPct`/`validateLevel` as the server, so client and server agree except when the price moves between view and save (the server error then shows inline).
    - Evaluator locks pending rows `FOR UPDATE` and writes only rows whose state changed (best_price included), so re-runs are no-ops; judged per market-local date of a single `asOf` moment because an IST evening is still the previous day in New York. Kept separate from U17 so the owner's "Re-evaluate now" and the EOD job share one path.
    - Scorecard: cancelled/edited calls are counted but not scored; hit rate = reached / resolved per kind (a triggered stop is a "reach" for stops). Share-link viewers get "Owner"/"Contributor N" labels: plain "Contributor" twice would merge two people's cards visually.
    - Holdings Upside had to fit a table that was already at its width limit at 1440 (measured: +56px overflow on first try). The editor trigger became the Upside cell itself (value, or "Set") instead of a separate icon button, the stop shows as a 0-decimal sub-line, and the name truncates at max-w-32; minimum table width 1062px vs 1070px available. An icon in the symbol cell was tried and wrapped long symbols onto a second line.
    - Redaction: `TARGET_POLICY` is empty (prices, dates and % only) but rows still go through `redactForActor`, so adding an amount later only needs the policy entry.

Implementation summary:
    - Tests: evaluate (12, pure): 1500/high 1510 → hit + 7 days; stop 900/low 899 → stopped; deadline 2026-12-31 best 1420 → expired, miss −5.33% (post-deadline 1600 bar ignored, still pending on the deadline day); deadline-day hit beats expiry; 2:1 split halves the threshold (740 raw no, 760 raw yes, best 1520 on the set basis; pre-set split ignored); null high/low → close; set-day and post-asOf bars ignored; resolved/cancelled immutable; stop expiry miss +5%; +20% at 1000 → 1200; upside; validation. Scorecard (2): 3 hit + 1 expired → 75%, median 20 days, avg miss; stops and set_by separate. View (5): active/history split, live distance, days left, canEdit per owner/contributor, share-link JSON without emails and numbered contributors, nearest marks. Actions + job (Neon, 5): contributor stamp with a spoofed set_by ignored, % stored as 1200/0.2; viewer rejected, wrong-side levels and past deadline refused; contributor can't cancel/edit the owner's target; edit → new row + old cancelled with replaced_by; seeded prices_daily bar → hit persisted, re-run idempotent, resolved edit/cancel refused. Full suite 298/298; lint, typecheck, build clean.
    - Mutation check: dropping the split factor from the threshold fails the split test; restored.
    - Browser check (scratch scripts only: temporary owner session + hide-amounts share link, `pnpm demo:seed` + scratch targets with owner and manager@example.com set_by and two watch items): targets Active/History/Scorecard, editor drawer (% preview, invalid stop inline error, new target with picker + deadline), holdings Upside, watchlist chips at 1440/375 light/dark; UI create then cancel persisted with the owner's set_by; Re-evaluate now → "Checked 3, 3 changed" then "0 changed". Viewer HTML on targets (3 tabs), holdings, watchlist: 0 emails, 0 target controls. No console errors, no page-level horizontal scroll. Cleanup: targets, watch items, TEST_/DEMO_ instruments, share links, users, sessions all 0; dev server stopped.

Follow-ups deferred:
    - U17 calls `evaluatePendingTargets(asOf, market)` after writing bars; until then statuses move only via "Re-evaluate now".
    - The symbol page editor entry point arrives with U19 (component and marks API are ready).
    - Holdings table already scrolls inside its card at 1280 (pre-existing); a responsive column-priority pass would fix it if it matters.

### 2026-11-11 — Buckets (U15): membership on buy events, inheritance inside ingest, equal-weighted paper, alpha with "Benchmark pending"

- Type: feature
- Scope: `src/db/schema/buckets.ts`, `drizzle/0006_buckets.sql`, `src/lib/buckets/{inherit,actions}.ts` + tests, `src/lib/ledger/ingest.ts` (copier entry + one call), `src/lib/returns/aggregate.ts` (+test), `src/lib/returns/benchmark.ts` (export `totalReturnIndex`), `src/lib/views/buckets.ts` + test, `src/lib/views/{holdings,watchlist}.ts` (+tests), `src/lib/watch/actions.ts` (export `authorEmail`), `src/app/(app)/buckets/{page,actions,controls,figures}.tsx`, `src/app/(app)/buckets/[id]/page.tsx`, `src/app/(app)/{holdings,watchlist}/page.tsx`, `src/components/chip.tsx` (Chip moved out of the watchlist page), `src/components/charts/benchmark-chart.tsx`, `src/components/shell/nav.tsx`

Reasoning / RCA / research:
    - Inheritance rule: a new buy inherits the buckets of the instrument's lots open just before it, found by replaying the live ledger up to its date without it (not "lots open at ingest time"). A backdated CSV buy then sees the state on its own date, and a sell + re-buy on the same day leaves nothing open, so no inheritance. Buys in one batch run in date order, so they chain.
    - Superseding events skip inheritance: they get exactly their predecessor's memberships from `copyBucketMembers`. Otherwise a fill replacing an inferred buy would pick up a bucket the owner had deliberately removed. The copier is one-to-many (every superseding buy/opening), fixing the orphaned-membership case the U11b copier signature allowed. The rows on the superseded event stay as history and views read live events only.
    - Called explicitly from `commit` after `linkWatchedBuys`, not via a self-registering hook (same reason as U14: an import side effect plus a cycle). The plan's "post-insert hook registry" doesn't exist; U14 also used an explicit call.
    - Members are `buy` or `opening` events (checked in `addMember` and the copier), so pre-ledger holdings can be bucketed. Bonus lots (their own event) are not members; a bonus on a member lot isn't attributed to the bucket (noted, rare).
    - Paper equal-weighting (U12 note): each paper item is `PAPER_NOTIONAL_INR` = ₹10,000 "bought" at `price_at_add` on the watch item's add date (not the membership date). Items without a price at add, a current price, or FX for a US add date are skipped and counted, not zeroed.
    - Alpha on the same basis as the return shown: under 365 days, absolute return minus the absolute return of the same INR flows in the index; from 365 days, U12's PME (direct alpha when units go negative). Per market: Nifty 50 for India members, S&P 500 in INR for US members. Any flow before the stored index or FX history → "Benchmark pending" (dev DB: NIFTYBEES has no closes; SPY and FX only from Oct/Nov 2026), never a made-up number.
    - Dividends: stored per-share amounts are on the raw basis while lots are post-split, so per-share is divided by later live split ratios (U12 note). India TDS comes from `settings.india_dividend_tds` (default 10%); no settings UI yet.
    - Permissions per the owner decision: create/add = suggest-level (contributors too), rename/edit and remove-member = `edit_own` on `created_by` / `added_by`, delete = archive, owner only. Inherited and copied rows keep the source row's `added_by`, so whoever tagged the old lot can remove the new one. Name uniqueness is a partial unique index on `lower(name)` among live buckets, so archiving frees a name.
    - Redaction: `BUCKET_REAL_POLICY` / `MEMBER_POLICY` drop money fields. Hide-amounts viewers get realized P&L as a % of money put in, and the chart rescaled to "per ₹100 put in" (shape kept, scale unknown). Share-link viewers see "Owner"/"Contributor", never emails.
    - The first dynamic-param route made `usePathname()` in the shell nav block the prerender (Next 16 "blocking-prerender-client-hook"). Fixed once in `nav.tsx`: the live nav is in `<Suspense>` with the same nav (nothing active) as its fallback, rather than `instant = false` on the page.

Implementation summary:
    - Tests: inherit (Neon, 4): Jan lot → March re-buy inherits; two buckets → both; full exit then re-buy → none (sold lot keeps its bucket); bucketed opening superseded by Console CSV → all three CSV buys carry it, the sell doesn't. Actions (Neon, 5): contributor creates (stamped), viewer can't; case-insensitive names; viewer add rejected, contributor adds buy and watch item, sell refused; contributor can't remove the owner's member or edit the owner's bucket; contributor delete rejected, owner archive OK and frees the name. Views (pure, 10): sold member's realized counts; paper equal-weighted and out of money totals; combined %; skipped paper; unpriced open lot excluded; hide-amounts keys absent, chart normalized, no emails; benchmark pending (none, history too late) and a number on a flat index; split-adjusted net dividends; role flags. Plus aggregate equal-weight, holdings bucket counts, watchlist chips. Full suite 274/274; lint, typecheck, build clean.
    - Mutation check: unhooking `inheritBuckets` and `copyBucketMembers` fails 3 of 4 inherit tests (the "no inheritance" one passes either way, as it should); restored.
    - Browser check (scratch Playwright script with a temporary owner session and a hide-amounts share link read from a file, `pnpm demo:seed` + scratch demo rows: a sold WIPRO lot, a recent NVDA lot, four watch items, buckets "Manager picks" and "Self"): list, detail and holdings `?bucket=` at 1440/375 light/dark, no horizontal scroll, no console errors; click-through create → add lot → remove → delete; viewer HTML had no emails, no amount keys, no controls. All rows removed afterwards (buckets, members, watch items, users, sessions, share links, demo instruments all 0).

Follow-ups deferred:
    - Alpha and the chart's benchmark line stay "pending" until U17 backfills NIFTYBEES/SPY and FX history; member price history for the chart likewise (cost fallback until then).
    - No unarchive for buckets and no member reassignment UI beyond remove + add.
    - Index dividends are still gross in `benchmark.ts` (U17's one-line withholding multiplier).

### 2026-11-11 — Watchlist (U14): watch items as paper members, Yahoo symbol search, buy auto-link inside ingest, paste and broker imports

- Type: feature
- Scope: `src/db/schema/watch.ts`, `drizzle/0005_watchlist.sql`, `src/lib/market/{search,instruments}.ts` + `search.test.ts`, `src/lib/market/yahoo.ts` (export `get`/`json`), `src/lib/watch/{actions,link-buys}.ts` + tests, `src/lib/ledger/ingest.ts` (2 lines), `src/lib/views/watchlist.ts` + `watchlist.test.ts`, `src/app/(app)/watchlist/{page,actions,controls}.tsx`, `src/components/segmented.tsx` (moved out of the holdings page), `src/components/tables/data-table.tsx` (mobile sort label), `src/components/shell/nav.tsx` (drop "Soon")

Reasoning / RCA / research:
    - Yahoo `/v1/finance/search` checked live: no crumb needed, but a request without a browser User-Agent gets 429, so it goes through yahoo.ts's `get` (now exported) rather than a bare fetch. Search returns no currency; it is derived from the exchange (NSI/BSE → INR, US codes → USD). Everything off NSE/BSE/US exchanges and anything but EQUITY/ETF is dropped; a `.BO` line is dropped when the same base ticker is on NSE.
    - Paste import resolves only an exact ticker (search hits are fuzzy, so "INFY" also returns HCL Infosystems); a fuzzy fallback would silently watch the wrong stock. A ticker listed in both markets (INFY: NSE and the NYSE ADR) resolves to India without a hint, since pasted lists come from Kite; the dialog has a market hint for the other case.
    - The add server action takes only the Yahoo symbol and re-runs the search server-side, so a client can't post a made-up name, market or currency into `instruments`.
    - Auto-link: called explicitly from ingest's `commit` (`linkWatchedBuys` after the ref copies; `REF_COPIERS = [copyWatchLinks]`) instead of a side-effect `REF_COPIERS.push` in link-buys.ts. A push only works if some module imports link-buys before the first ingest, and importing it from ingest.ts creates a cycle. The order matters: copies first, so a link remapped onto a superseding fill is never overwritten by "first new buy".
    - Only `type = 'buy'` links, compared by market-local date ≥ the add date. Openings are their own type, so a first sync of a stock the owner already held never shows as "bought". Archived items never link; a linked item is never relinked.
    - Uniqueness of the active item is a partial unique index (`instrument_id WHERE archived_at IS NULL`), and the insert is `ON CONFLICT DO NOTHING` + re-read, so two people adding the same stock at once get one row. Archiving frees the slot, so re-adding later starts a fresh item with a new price at add.
    - Broker import runs with no actor (cron, U10) and stamps the owner's email. An item the owner archived that carries the `source:<broker>` tag is not recreated on the next sync; otherwise archiving a broker-synced item would be pointless.
    - Redaction: watch rows carry only prices, dates and percentages, so a hide-amounts actor sees the same numbers (R4), and the linked buy's quantity is never loaded. Emails are what's sensitive here: share-link viewers (anonymous) get "Owner"/"Contributor" instead of `created_by`.
    - The "vs added" delta on a linked buy is plain text, not a green/red Delta: paying more than the watch price isn't a gain, so gain/loss coloring would mislead.

Implementation summary:
    - Tests: 8 pure view tests (return since added; annualized null at 364 days, XIRR 10% at 730 days with 1000 → 1210; linked-buy delta; unavailable price; canEdit per role; share-link viewer JSON has no emails; tag counts active-only; New York dates), 2 search parse tests from a trimmed live response, 3 Neon link tests (first buy after add links with price/date, earlier buy ignored, second buy doesn't relink; archived not linked; inferred buy superseded by a fill moves the link), 6 Neon action tests (contributor stamp + latest price; viewer rejected; contributor can't edit/archive owner's item; duplicate add returns existing; paste TCS/INFY/XYZNOTREAL → 2 added 1 unresolved then 2 existing; broker import idempotent, tagged, archive respected). Full suite 252/252.
    - Mutation check: unhooking `linkWatchedBuys` and `copyWatchLinks` from ingest fails 2 of the 3 link tests; restored.
    - Browser check (temporary owner session + hide-amounts share link from the scratch `mkauth.mts`, demo rows `DEMO_W_*` from a scratch seed; no code added): 1440 and 375 in light and dark, live search grouped India/US, paste dialog report, edit dialog, tag filter, archived view, empty tag filter. The share-link viewer page had no combobox, paste, sync or row-action controls and no email in the HTML. No horizontal scroll at 375. All demo, session, user, share-link and tag rows deleted and verified 0.

Follow-ups deferred:
    - No unarchive control yet; add it if archived items need restoring (the partial index allows it once no other active item exists).
    - US paste of class shares needs Yahoo's spelling (BRK-B); "BRK.B" finds nothing in search.
    - The prices job (U10) must include watched instruments; until then current prices come from the on-demand fetch at add time.

### 2026-11-11 — App shell, Overview and Holdings (U13): view-module redaction, URL-persisted table, state matrix, palette toggle

- Type: feature
- Scope: `src/lib/views/{holdings,connections}.ts` + `holdings.test.ts`, `src/app/(app)/{layout,page,error}.tsx`, `src/app/(app)/holdings/page.tsx`, placeholder pages `src/app/(app)/{watchlist,buckets,targets,trades,history,allocation}/page.tsx`, `src/components/{money,can,empty-state,holding-badges,palette-toggle,theme-toggle}.tsx`, `src/components/tables/data-table.tsx`, `src/components/charts/allocation-donut.tsx`, `src/components/shell/{nav,sign-out-button}.tsx`, `src/lib/palette.ts`, `src/app/layout.tsx`, `scripts/demo-{seed,clean}.mts`, `package.json` (demo:seed, demo:clean)

Reasoning / RCA / research:
    - View-module pattern: `getHoldingsView()` calls `requireActor()` itself, loads, then hands everything to the pure `buildHoldingsView(inputs, actor)`, which does the math and the redaction. Pages never touch the DB, and the whole money path is unit-tested without Neon. Redaction runs on rows AND totals (`HOLDING_POLICY`, `TOTALS_POLICY`); prices (avg cost, LTP) and percentages stay, per R4.
    - Hide-amounts UI drops amount-only columns (Qty, Invested, Value, P&L) and shows Weight instead of a table of dashes. The default "value" sort is implemented as a weight sort, which orders identically and survives redaction, so a viewer's row order matches the owner's without leaking anything.
    - Lots come from `loadLedger` + `replay` rather than `getLedgerState`, because the approximate flag lives on the opening event and `ReplayResult` drops events. A holding with a snapshot but no ledger lots yet falls back to the broker average as one approximate lot instead of disappearing.
    - Avg cost / invested use open FIFO lots (positionPnl), not Kite's weighted average. Considered showing the broker average for parity with the Kite app, rejected: invested, P&L and the US FX split must come from the same lots, and they differ only after a partial sell.
    - URL-persisted table state (`?market=&sort=&dir=&ccy=`): headers, tabs and the USD/INR toggle are plain links rendered on the server, so sorting is shareable, survives reload/back, needs no client JS, and `aria-sort` is just server output. Defaults are omitted from URLs.
    - State matrix: no data (owner CTA "Connect a broker" vs "Waiting for the first sync" vs neutral text for others), partial (a market card with no holdings says so, with an owner-only connect button), `price_unavailable` (row badge, excluded from every total, overview note and per-card count), stale/failed broker (stacked banner per broker: owner sees the failing step + Reconnect, others only "Kite data as of ..."), approximate cost (one `≈` glyph with tooltip, sr text and an on-screen legend), loading (content-shaped Suspense skeletons), error (`(app)/error.tsx`, Next 16 `retry` prop).
    - Role-conditional controls: `<Can action>` server helper hides what the actor can't use (settings group, Reconnect, connect CTAs); `SessionOnly` hides sign-out for share-link viewers. UI only: actions still `authorize()`.
    - Palette: `data-palette="cb"` on `<html>`, persisted in localStorage, applied by an inline script in the root layout before first paint (no flash). The constant lives in a plain module because a `"use client"` file's exports reach a server component as client references, not strings. The toggle reads the attribute through `useSyncExternalStore` + MutationObserver, which avoids set-state-in-effect.
    - Missing values render "—" as the plan specifies (deliberate exception to the design skill's em-dash rule, which targets prose, not empty table cells).

Implementation summary:
    - 11 pure tests: combined INR = sum of INR rows, IN+US = all; U12 FX example (USD 0%, INR/FX ≈13.25%) at row and section level; previous close picked before the price's market date; approximate/T+1/unpriced flags and exclusion; no-lots fallback; LTCG days (111 days, US 24 months); allocation top 6 + Other sums to 100%; empty → empty DTO; hide-amounts JSON has none of the policy keys while percentages stay; banners: owner gets the step, viewer only the date, never-connected → no banner, late sync flagged.
    - Demo data (`pnpm demo:seed` / `demo:clean`): `DEMO_*` instruments, sync run job `demo`, `demo:*` ledger refs, FX source `demo` inserted only if the date is missing (real FX rows are never overwritten). Clean deletes via instrument cascade and asserts 0 left.
    - Browser check with a temporary owner session row + signed cookie and a temporary hide-amounts share link (no code added): Overview/Holdings at 1440 and 375, light/dark/cb, More sheet, empty states, failing-Kite banner; viewer HTML contained none of the amount keys or labels; sign-out lands on /sign-in; no horizontal scroll at 375. All temp rows deleted (user/session/share_links/broker_connections back to 0).
    - Fixed during the visual pass: donut used the grey chart-5 next to the grey "Other" slice; badges inherited the mono font in numeric cells; hidden-amount market cards repeated the headline return as a row; the legend explained markers not present in the filtered tab; mobile header toggles kept the dark outline background.

Follow-ups deferred:
    - Day change ignores a split between the previous close and today (`ponytail:` note in `holdings.ts`); adjust by corporate actions if it shows up.
    - US day change in INR uses today's FX for both days (FX move not attributed to the day).
    - Margins card and "Due for review" slot are placeholders (U10, U20). Bucket tabs and upside-to-target are U15/U16.

### 2026-11-11 — Ledger DB layer (U11b): run-keyed snapshots, transactional ingest, review queue, ref-copier registry, import page

- Type: feature
- Scope: `src/db/schema/ledger.ts`, `drizzle/0004_ledger.sql`, `src/lib/ledger/{ingest,queries}.ts` + `ingest.test.ts`, `src/app/(app)/settings/import/{page,actions,import-form}.tsx`, `src/app/(app)/layout.tsx` (nav link), `next.config.ts` (`experimental.serverActions.bodySizeLimit: "4mb"`)

Reasoning / RCA / research:
    - Transaction boundaries: every public call does its network work first (ensureFxRange, U8 `backfillHistory` for split history), then opens ONE Pool transaction. Inside it a global `pg_advisory_xact_lock` is taken and the ledger is re-read and re-planned with the pure core before any write. A dry run of the same planner on the pool decides what to prefetch, so the code path is identical inside and outside the transaction. Holding a transaction open across Yahoo/Frankfurter calls was rejected: on Neon's WebSocket pool that pins a connection for seconds. Reading state before the lock and writing after it was also rejected, because a Kite run racing a CSV import could double-infer.
    - Event ids are name-based uuids of `source_ref` (`eventId`). The pure core uses id = sourceRef for new events, so supersession links and `refRemap` can be planned before insert and mapped with one function. Re-ingesting lands on the same row. The alternative (insert, read back ids, translate) costs a round trip and a mapping table per call.
    - Idempotency: inserts are `ON CONFLICT (source_ref) DO NOTHING`, and links are `DO NOTHING` on their pk. Before planning supersession, incoming events whose source_ref is already stored are dropped. Without that, a re-sent fill was re-allocated to a later inferred event, because the first one was no longer live.
    - Snapshots are keyed by run (adopted fix), unique (run_id, instrument_id). `prev` = the latest earlier snapshot of the same broker and instrument from another run. Synthesizing 0-qty rows for "held but missing" instruments was implemented first and then removed: a test run (or any partial run) would have inferred sells on every other instrument that broker holds, including real data in the same DB. U10 writes the explicit 0-qty row instead, which is the U11a note's contract.
    - Prices for inferred sells come from the official `prices_daily` close if EOD has stored it. Otherwise `price_latest`, then the snapshot's ltp. Anything but the close also opens an `approximate_sell` review item, so U17 has a worklist. No price at all → an `unexplained` item, no event.
    - Review queue: a partial unique index on (instrument_id, kind) WHERE resolved_at IS NULL dedupes open items in the DB, and `ON CONFLICT ... DO UPDATE detail` keeps the newest context. `pending_lag` auto-resolves on the next non-lagging run. The kind enum adds `cost_mismatch`, `price_fallback` and `exceeds_broker` to the brief's five, because the pure core emits them.
    - Ref copying: bucket_members, watch_items and journal don't exist yet, so `REF_COPIERS` is a plain array that U14/U15/U20 push onto. It runs inside the ingest transaction, so a failing copier rolls back the whole import (tested).
    - Imports: instruments are find-or-created BEFORE the transaction. They're reference data that U10 would upsert anyway, and U8's split fetch needs the row. Parse errors return before anything is written. The Console import skips FX prefetch (INR, rate 1). A reconcile shortfall opening is dated at the instrument's first imported trade, because shares the file can't explain were most likely bought before it starts.

Implementation summary:
    - 8 Neon integration tests with mocked fetch (Yahoo chart + Frankfurter), unique `TEST_<tag>_` instruments, full cleanup (verified 0 leftover rows). They cover: bootstrap + inferred buy idempotent across re-runs; a fill superseding an inference with replayed qty = snapshot; top-up lag → no event + pending_lag, resolved next run; split fetched on demand → split event, no buy; Console CSV supersedes the opening, the copier gets opening → 3 CSV buys, re-import is a no-op; a malformed CSV writes nothing, a throwing copier rolls back, a viewer is refused; USD snapshot FX prefetched; US history supersedes the US opening with weekend-forward-filled FX.
    - Mutation check: disabling the on-demand split fetch fails the split test, and disabling the FX prefetch fails the USD test ("non-finite qty/price or missing FX rate").
    - A guard in `toRow` refuses non-finite qty/price/fx. Postgres numeric accepts 'NaN' and orders it above every number, so the `fx_rate_inr > 0` CHECK alone would let it through.
    - Owner page `/settings/import`: two upload forms → server actions (`authorize("manage")`), with a row-numbered error list or a summary (events added, estimates replaced, residuals sent to review).

Follow-ups deferred:
    - The INDmoney US history format is assumed (`date,symbol,side,quantity,price,order_id`) until the U1 spike. Only `parseUsHistory` should change.
    - DB tests are slow from a laptop (~250 ms/round trip, ~100 s for the file). The describe block has a 120 s timeout.
    - The ledger lock is global; per-instrument locks only if ingest ever contends. On-demand split fetch runs once per residual instrument per run; cache negatives if Yahoo starts rate-limiting it.

### 2026-11-11 — Auth and access (U4): Better Auth Google sign-in, per-request roles, grants, share links, redaction; brokers settings page

- Type: feature
- Scope: `src/lib/auth/{config,client,grants,access,share-link,redact}.ts` + tests (`access.test.ts`, `access.db.test.ts`, `redact.test.ts`), `src/db/schema/auth.ts`, `drizzle/0003_auth_access.sql`, `src/proxy.ts`, `src/app/api/auth/[...all]/route.ts`, `src/app/sign-in/*`, `src/app/s/[token]/route.ts`, `src/app/s/invalid/page.tsx`, `src/app/(app)/{layout,page}.tsx`, `src/app/(app)/settings/{sharing,brokers}/*`, `src/components/page-skeleton.tsx`, `docs/adr/0003-auth-better-auth.md`

Reasoning / RCA / research:
    - Better Auth 1.7 over Auth.js (maintenance-only) and hosted auth (vendor store for a one-owner app). Its `user.create.before` hook is the only place that can veto sign-up before the row exists; an `after` hook can't. The hook throws `APIError` with code `NOT_INVITED` / `ACCESS_EXPIRED`, which Better Auth forwards to `errorCallbackURL` as `?error=<code>` (read from `callback.mjs`), so the sign-in page can explain the denial.
    - Roles are resolved per request in the data-access layer (`requireActor()` / `authorize()`), never stored on the user, never decided in proxy or layout. A layout doesn't re-render on client navigation and proxy only sees cookies, which is how the old app leaked. No Better Auth cookie cache, so a revoked/expired grant takes effect on the next request; on denial the user's sessions are deleted (sign-out everywhere).
    - Grants keyed by lowercased email with no FK to `user` (adopted fix): invites predate the first sign-in. A DB CHECK enforces lowercase, so a mixed-case insert can't create a second "unique" row. Re-inviting upserts the row and clears `revoked_at`.
    - Share links live outside Better Auth: token = 32 random bytes base64url, only sha256 stored; cookie `sb_share = <id>.<HMAC>` so a client can't swap in another link id; the row is re-validated every request and `last_used_at` written at most hourly. The table has no role column and the resolver hardcodes viewer, so a tampered row can't escalate.
    - Redaction is absence, not zero: `redactForActor` deletes policy fields, so a hide-amounts payload carries no trace of quantities or money (asserted on the JSON). Typed `Redacted<T,K>` makes amount fields optional so later UI must handle the dash case.
    - Cache Components gotcha: dev "instant navigation" validation flagged `new Date()` after `cookies()` and then `connection()` outside Suspense even though the (app) layout wrapped `{children}`. A parent-layout boundary doesn't count for client navigations between sibling pages; each page now renders its actor-dependent content inside its own `<Suspense>`, and `getActor()` starts with `await connection()`.

Implementation summary:
    - Matrix written test-first (25 pure/mocked tests: roles x actions x grant states, owner case variants, edit_own resource-owner rule, link tamper/expiry/revoke, HMAC tamper/wrong secret, contributor calling the credential-save server action rejected). 10 Neon tests (gate: uninvited/expired/revoked throw, invited/owner pass any case, no user rows, lowercase CHECK 23514; share cookie: viewer + hourly touch, revoked/expired/forged/unknown → null). 4 redact tests incl. a real `positionPnl` result.
    - Better Auth tables generated with `auth@1.7.16 generate` (drizzle, pg) and merged into `src/db/schema/auth.ts`; migration `0003_auth_access` applied to Neon.
    - Smoke on `next dev`: `/` → 307 `/sign-in` with no cookie; `/s/garbage` → 307 `/s/invalid` and clears `sb_share`; a seeded share link sets the cookie and renders the read-only banner; revoking it redirects to `/s/expired` (→ invalid page, cookie cleared); a seeded owner session renders both settings pages. Seed rows deleted.
    - `.env.local` gained `BETTER_AUTH_SECRET`, `SHARE_LINK_SECRET`, `OWNER_EMAIL`, `BETTER_AUTH_URL`, empty Google vars; Vercel production + preview got independently generated `BETTER_AUTH_SECRET` / `SHARE_LINK_SECRET` and `OWNER_EMAIL` (preview via the empty branch arg).
    - Brokers settings (deferred from U5): owner-only, shows `publicConnectionView` only, write-only Kite form; connect buttons are disabled placeholders.

Follow-ups deferred:
    - Live Google sign-in waits on the owner's OAuth client (redirect URIs in `tasks/todo.md`). `BETTER_AUTH_URL` is not set in Vercel production yet (needs the prod domain).
    - Sign-out button and role-conditional nav belong to the U13 shell. Preview deploys can't use Google sign-in unless a stable preview domain is registered.
    - Error strings use a period instead of the spec's em-dash (design-taste rule); wording otherwise as specified.

### 2026-11-11 — Ledger engine pure core (U11a): residual inference, corporate-action window, FIFO replay, link-table supersession, CSV import

- Type: feature
- Scope: `src/lib/ledger/{types,infer,corporate-actions,lots,supersede,csv-import}.ts` + tests + `__fixtures__/{ev.ts,console-tradebook.csv}`, `docs/adr/0005-event-sourced-ledger.md`

Reasoning / RCA / research:
    - Residual inference (adopted fix over the plan's "snapshot diff → event"): the plan diffs consecutive snapshots, so a fill already ingested plus the diff's inferred buy double counts. We replay the ledger as of `takenAt` (fills included by `executedAt`) and infer only `snapshotQty − ledgerQty`. Top-up lag (fill at 10:00, 15:45 snapshot still old qty) would otherwise infer a phantom sell; recent fills (last 2 weekdays) that cover the gap in the opposite direction → `pendingLag`, write nothing. The window expires, so a fill the broker never reflects still gets reconciled.
    - Buy residual is priced on the broker's weighted-average basis, not FIFO remaining cost (deviation from the brief's "ledgerCost"): Kite's avg doesn't move on sells, so after a partial sell FIFO cost gives a wrong implied price (test: lots 10@100 + 10@200, sell 10, buy 10 at 150 → FIFO basis implies 100). Replay therefore also returns `positions` {qty, cost} on that basis.
    - Corporate-action window: brokers credit a split/bonus days after the ex-date, so a candidate matches when ex-date ∈ [diff − 14d, diff]. Q ≥ L×f → credited (remainder beyond 0.5% = concurrent trade, the split+buy branch); Q ≤ L → not credited yet (valuation uses `pendingFactor`); in between is ambiguous → unexplained. No action but cost unchanged → a qty change that adds no cost isn't a trade → unexplained (caller can fetch split history on demand). Actions before the ledger's first buy are ignored: they're already in the opening qty.
    - Allotment dating: CA events carry `date` = credit date and `exDate`. Replay orders by ex-date (bonus qty counts holdings at the ex-date; post-ex trades stay post-split) but the bonus lot is dated `date`, so LTCG starts at allotment. One ratio convention (post/pre, Yahoo's "2:1" for a 1:1 bonus) makes the owner's reclassification a type flip. `exDate` is an addition to the brief's LedgerEvent shape.
    - Link-table supersession: one opening → many CSV buys, one inferred → many partial fills. `refRemap` lists every superseding buy so the DB layer copies bucket/watch/journal refs (plan's single `superseded_by` column orphaned them). Partial fill coverage emits an approximate `:rem` remainder linked as a superseding event, so totals reconcile without waiting for the next sync. CSV row and Kite fill with the same trade id: CSV wins.
    - CA `sourceRef` is `action:<instrument>:<exDate>` for both live matches and historical CSV inserts, so the unique key stops one action applying twice.

Implementation summary:
    - 61 tests, test-first (all five files failed on missing modules before implementation); mutation spot-checks: dropping the lag return fails the top-up test, FIFO-basis cost fails the avg-basis and FIFO tests.
    - `sellFifo` reused from `src/lib/returns/pnl.ts`; oversells clamped and flagged before calling it.
    - CSV: strict header set, per-row errors with file line numbers, duplicate trade_id rejected; `dateRange` for FX prefetch outside the transaction; `reconcile` turns a shortfall into a flagged approximate opening; `applyHistoricalActions` inserts splits/bonuses after the first trade.

Follow-ups deferred:
    - DB layer (U11b): `schema/ledger.ts`, `ingest.ts` transaction (insert remainders before links, copy refs per `refRemap`), settings import page.
    - Lag window and CA window ignore exchange holidays; two actions inside one 14-day window take only the latest.
    - Console `trade_id` uniqueness across years is unverified; if it repeats, `csv:` refs need the exchange/date in them.

### 2026-11-11 — Secrets + broker credentials (U5, library/schema part): AES-GCM envelopes, broker_connections

- Type: feature
- Scope: `src/lib/crypto/secrets.ts` + test, `src/db/schema/brokers.ts`, `drizzle/0002_broker_connections.sql`, `src/lib/brokers/connections.ts` + test, `.env.example`, `docs/adr/0009-secret-encryption.md`

Reasoning / RCA / research:
    - Envelope `v1:<iv>:<tag>:<ct>` (base64url, 12-byte random IV, 16-byte tag pinned via `authTagLength` so a truncated tag can't weaken auth). The version prefix leaves room for a future scheme without guessing a row's format.
    - Decrypt never falls back. The previous app treated "not an envelope" as plaintext, which turns a wrong key or a plaintext row into a working credential with no signal; here tamper, wrong key, unknown version and malformed input all throw, and errors never echo ciphertext. A DB `CHECK` (non-null secret columns must start `v<n>:`) backs this up at the storage layer.
    - Key validation is a strict regex (43 base64 chars + `=`) rather than a decoded-length check, because `Buffer.from(_, "base64")` silently skips invalid characters. Read on every call, not cached, so tests and rotations see env changes; the cost is one tiny base64 decode.
    - Separate keys for prod, preview and local dev (adopted fix): a preview/dev leak can't decrypt prod rows. Rotation is a decrypt-only `ENCRYPTION_KEY_PREVIOUS`; no re-encryption job (YAGNI), secrets get re-saved instead.
    - `getConnection` selects status columns plus a SQL-computed `credentialsSet`, never the `*_enc` columns, so callers can't accidentally forward ciphertext; `publicConnectionView` picks fields explicitly so a new column never leaks to the UI.
    - OAuth connect state stored as hash + encrypted verifier + expiry (adopted fix: state bound and single-use); the helpers for it land with U6.

Implementation summary:
    - 11 crypto unit tests (round-trip incl. unicode/empty, IV uniqueness, flipped iv/tag/ct, truncated tag, wrong key, previous-key rotation, missing/short key naming the variable, unknown version). 4 Neon tests: only `v1:` in raw columns, CHECK rejects plaintext (23514), public view has exactly 6 status keys, `setStatus` redacts a JWT. Tests stub their own key and snapshot/restore the singleton rows.
    - `redact` reused from `src/lib/jobs/handler.ts`. `server-only` is not a dependency, so the server-only rule is a header comment.
    - `ENCRYPTION_KEY` appended to `.env.local`; Vercel production and preview set with independently generated keys. Gotcha: `vercel env add NAME preview` (CLI 54) refuses non-interactively with `git_branch_required` even with `--value`; pass an empty branch arg `""` to target all preview branches.

Follow-ups deferred:
    - Settings/brokers page and owner-only server actions wait for U4 (auth).
    - MCP client-info and OAuth state/verifier helpers, and `last_sync_at` writes, belong to U6/U10.

### 2026-11-11 — Market data (U8): Yahoo/Frankfurter/Google News fetchers, raw price storage, corporate_actions + dividends

- Type: feature
- Scope: `src/lib/market/{yahoo,symbols,fx,news,prices,seed}.ts` + tests + `__fixtures__/`, `src/db/schema/market.ts`, `drizzle/0001_market_events.sql`, `scripts/{seed,market-smoke}.mts`, `package.json` (db:seed, market:smoke), `docs/adr/0006-prices-from-db-yahoo-primary.md`

Reasoning / RCA / research:
    - Raw storage (adopted fix, overrides the plan's "store as returned"): Yahoo `close` is back-adjusted, so a late split rewrites history. We multiply each bar by the cumulative factor of splits strictly AFTER its date (the ex-date bar is already post-split; verified on AAPL 2020-08-31 4:1). Volume is divided and dividend amounts multiplied by the same factor, since Yahoo adjusts both too.
    - Refetch-on-event: any newly inserted split/dividend on a partial-range fetch triggers a `range=max` refetch, so no stored bar is left on a stale basis. Detection is `INSERT ... ON CONFLICT DO NOTHING RETURNING`; existing rows are never touched, so an owner's bonus reclassification survives.
    - Crumb: `quoteSummary` crumb+A3 cookie cached in `settings.yahoo_crumb` so serverless invocations share it; one refetch on 401. `crumbStore` is a plain object so tests spy on it instead of mocking Drizzle.
    - MCP fallback is an injected `QuoteFallback` (default no-op) because U6 does not exist yet. A failed refresh never writes zero: the last price stays; `price_unavailable` only on a definitive 404 the fallback also missed. Spark silently drops unknown symbols from a mixed batch (live-tested), hence the per-symbol `chart` probe for missing ones; a 429 skips straight to the fallback rather than hammering Yahoo.
    - FX: `ensureFxRange` counts rows in range and makes one time-series call (starting 7 days early so a weekend start has a rate to carry). Forward-filled rows are tagged `*_ffill`; `refreshFx` re-pulls 10 days with upsert so a same-day ffill gets replaced once ECB publishes.
    - News parsed with a ~30-line regex parser instead of adding `fast-xml-parser`: Google's RSS is flat and well-formed.

Implementation summary:
    - New tables `corporate_actions` (kind enum split|bonus, unique instrument+ex_date) and `dividends` (gross, raw basis); migration `0001_market_events` applied. `pnpm db:seed` upserts NIFTYBEES/SPY benchmarks (idempotent, ran twice).
    - Unit tests mock `fetch` with recorded/hand-written fixtures; `prices.test.ts` is a Neon integration test (skips without DATABASE_URL) covering 429→mcp, 404→unavailable/no zero, raw backfill + refetch, sector override, ensureFxRange, seed idempotency.
    - Scripts are `.mts` and run via `tsx` (transitive dep of drizzle-kit/vitest; adding it directly was out of the one-package budget). Gotcha: an ESM script cannot named-import from `@/db/schema` (CJS `export *` re-exports are invisible to Node's lexer); import through the lib modules or default-import.
    - Live check: smoke script OK for RELIANCE.NS, AAPL, ^NSEI, USDINR=X and Frankfurter latest; live refreshLatest/enrich/refreshFx/news ran against the DB.

Follow-ups deferred:
    - U6 plugs the MCP quote tool into `QuoteFallback`; U9/U17 call `refreshLatest`, `backfillHistory`, `refreshFx` from cron.
    - Dividend `pay_date` stays null (Yahoo chart gives ex-date only); fill from broker data in U11 if needed.

### 2026-11-11 — Cron infrastructure (U9): authenticated job route, sync_runs tracking, GitHub Actions schedules

- Type: feature
- Scope: `src/app/api/cron/[job]/route.ts`, `src/lib/jobs/{handler,registry,schedule}.ts` (+ tests), `.github/workflows/{cron-*,backfill,keepalive}.yml`, `docs/adr/0008-cron-github-actions.md`, `.env.local` (`CRON_SECRET`)

Reasoning / RCA / research:
    - GitHub Actions over Vercel cron: Hobby cron is daily-only with hour-level jitter, which can't do 15-minute prices; Actions is free and gives `workflow_dispatch` for manual runs (ADR-0008).
    - DST: cron is UTC-only, so the US price window is 13:30–21:00 UTC (covers EDT and EST) and the job itself decides with `isMarketOpen`, which uses `Intl` timezones rather than hard-coded offsets. A fixed 14:30 UTC window would miss the first hour every summer.
    - Keepalive: scheduled workflows are auto-disabled after 60 days without repo activity. Monthly `gh workflow enable` on every cron workflow (including keepalive itself) resets that with the built-in `GITHUB_TOKEN` + `actions: write`; a PAT was rejected as an unnecessary long-lived secret.
    - Stuck runs: a Vercel 300 s kill never reaches the handler's `finally`, so a `running` row would block the job forever under the overlap guard. Rows `running` > 10 min are marked `failed` ("stale: exceeded runtime (killed)") on the next call. Check-then-insert runs under `pg_advisory_xact_lock(hashtext('cron:<job>'))` because a plain select-then-insert lets two concurrent calls both start.
    - Overlap check looks for any `running` row, not "the latest row": otherwise a `skipped` row becomes the latest and the third concurrent call would run.
    - Staleness is schedule-aware: stale iff no success at/after the newest weekday slot whose grace has elapsed. "Now minus N hours" would flag every Monday morning; checking only the most recent slot would hide a missed earlier day while today's slot is still in grace. kite-sync's 17:00 IST self-heal is folded into its grace (150 min) rather than being its own slot, so a good 15:45 run isn't flagged stale at 17:00.

Implementation summary:
    - `createCronHandler(registry)` in `src/lib/jobs/handler.ts` so tests inject a fake registry; `route.ts` only re-exports `POST`/`GET` (Next rejects non-route exports in `route.ts`). No `runtime`/`dynamic` exports; build lists the route as `ƒ` (dynamic).
    - Bearer compared via `timingSafeEqual` on SHA-256 digests (equal length, no length leak); `CRON_SECRET` under 16 chars → 500 `misconfigured`. Auth runs before job lookup so unknown names don't leak; `Object.hasOwn` blocks `constructor`-style keys.
    - Errors are redacted (JWT, `Bearer`, `*token=`, cookie, password, secret, api_key, totp) before storage and response; a mutation check (redaction removed) fails the test.
    - Chunk cursor: stored on the row only when the job returns `done: false`; the next run receives the latest completed row's cursor. `backfill.yml` loops until `done=true` (max 200, 2 s apart).
    - Tests: 9 route tests on real Neon (rows cleaned by unique job prefix) + 8 schedule tests; 17/17 pass. `next start` smoke: GET/PUT 405, unauthenticated POST 401.

Follow-ups deferred:
    - All jobs are no-op placeholders; U7/U8/U10/U17 replace them. The prices job must call `isMarketOpen` per market.
    - GitHub secrets `APP_URL` and `CRON_SECRET` get set at the repo-creation checkpoint (no repo yet). Market holidays not modelled.

### 2026-11-11 — Returns engine (U12): XIRR, P&L, FX split, PME benchmark, LTCG dates, bucket aggregate

- Type: feature
- Scope: `src/lib/returns/{types,xirr,pnl,fx-returns,benchmark,tax,aggregate}.ts` + `*.test.ts`, `docs/adr/0007-fx-method.md`

Reasoning / RCA / research:
    - XIRR hand-rolled (Excel actual/365): Newton from 0.1, bisection on [-0.9999, 10] when Newton leaves the domain (rate ≤ −100%) or fails to converge. No library: the math is ~40 lines and a dependency would not handle the fallback or the null contract (null without mixed-sign flows or without a root in the bracket). Cross-checked against Microsoft's documented Excel example (0.373362535, within 1e-6); a 99% loss fixture proves Newton fails and bisection recovers.
    - Spans under 365 days return `useAbsolute` with absolute return (money out / money in − 1) and xirr null, so the UI cannot accidentally show an annualized 10-day move.
    - Dividends recorded net of withholding (owner decision in `tasks/todo.md`, overrides the plan's gross wording): `withholdingRate` is a parameter (US `US_DIVIDEND_WITHHOLDING` = 0.25, India TDS from settings); gross is returned alongside. Net is what lands in cash flows and total return. Ex-date eligibility: bought before ex-date, a sale on the ex-date still receives it.
    - Benchmark total return built from raw close + dividends reinvested at the ex-date close + split ratios, not Yahoo adjclose (adopted fix): stored prices are raw, and adjclose is re-based retroactively whenever a new dividend lands, which would silently rewrite past PME results.
    - Long-Nickels PME replicates each flow as index units at the previous-or-same trading day's level; S&P converts through the FX series for the INR view. When replicated units go negative, PME is undefined, so it falls back to direct alpha (XIRR of flows compounded to the end date by the index) and flags `method: "direct-alpha"`.
    - Plain float64 numbers, no decimal library: returns/ratios need no more, amounts stay far inside 2^53 paise, and nothing rounds before presentation.

Implementation summary:
    - `sellFifo` (FIFO matching, non-mutating, throws on oversell) lives here so U11's lot replay can reuse it rather than re-implement it.
    - `positionPnl` returns realized/unrealized in native and INR plus investor-sign `flows` (buys, sales, net dividends, terminal value) that feed XIRR, the benchmark and `aggregate`.
    - Paper items are one notional unit at `price_at_add`; they get separate returns and appear only in `combined`, never in money totals.
    - Test-first: 6 suites failed on missing modules, then 43 tests pass; `pnpm test` (47), `typecheck`, `lint` clean.

Follow-ups deferred:
    - U11 must feed dividend per-share and lot qty on the same split basis (lot qty is split-adjusted; check whether stored dividends are too).
    - Index dividends in the benchmark are gross; if alpha should compare against an after-withholding SPY, apply the 25% there too (one multiplier).
    - Paper returns are price-weighted (1 unit each), per the plan; equal-weighting is the alternative if a high-priced item dominates.

### 2026-11-11 — Database foundation (U3): Drizzle on Neon, single Pool client, market/ops schema

- Type: feature
- Scope: `src/db/index.ts`, `src/db/schema/{index,market,ops}.ts`, `src/db/schema/market.test.ts`, `drizzle.config.ts`, `drizzle/0000_init.sql`, `vitest.config.ts`, `package.json` (db:* scripts), `pnpm-workspace.yaml`, `docs/adr/0004-drizzle-neon-single-pool-driver.md`

Reasoning / RCA / research:
    - One `neon-serverless` Pool (+ `attachDatabasePool`) instead of the plan's two drivers: every caller gets interactive transactions and Better Auth reuses it; the rejected `neon-http` read client only saves a cold WebSocket handshake. Recorded as ADR-0004, which supersedes the plan's two-driver wording.
    - `prices_daily` stores raw (unadjusted) OHLC (adopted review fix). Yahoo's adjusted series is rewritten retroactively when a split lands, which would silently change stored history and target hits; adjusting in code from corporate-action events keeps the stored data immutable. `adj_close` is kept for reference only. open/high/low are nullable because some sources give close only.
    - All money/qty columns are `numeric` in Drizzle `mode: "string"`: exact in the DB and never coerced through JS floats. The decimal library for arithmetic is deferred to U12.
    - Env loading uses Node's `process.loadEnvFile(".env.local")` guarded by `existsSync`, in both `drizzle.config.ts` and `vitest.config.ts`: no `dotenv` dependency, and CI (no file) skips the DB tests via `describe.skipIf(!process.env.DATABASE_URL)`. Vite's `loadEnv` was tried first but `vite` is not resolvable at top level under pnpm.
    - `pnpm-workspace.yaml` `allowBuilds.esbuild: false`: pnpm 11 wrote a placeholder that blocks `pnpm exec`; esbuild's postinstall only validates the binary, which the platform package already provides.

Implementation summary:
    - Packages: drizzle-orm 0.45.4, @neondatabase/serverless 1.2.0, @vercel/functions 3.10.6, drizzle-kit 0.31.11 (dev).
    - Migration `drizzle/0000_init.sql` generated and applied to the linked Neon DB: instruments, prices_daily, price_latest, fx_daily, sync_runs, settings.
    - Integration test (real Neon): duplicate (market, broker_symbol) raises 23505; `1234.5678` and `0.000123` round-trip exactly. Rows use a random prefix and are deleted in `afterAll` (verified 0 leftovers).

Follow-ups deferred:
    - `corporate_actions` table lands with U8, which fetches split/dividend events.
    - Adopted fix "dev Neon branch schema-only, separate dev/preview secrets" not done here: `.env.local` points at the Vercel-linked branch. Needs a Neon dev branch before real data lands.
    - Plan verification "both clients query from a deployed route handler" waits for the first Vercel deploy (end of Phase 1).

### 2026-11-11 — Scaffold Stockboard rewrite (U2): Next.js 16 + shadcn + test/CI tooling

- Type: build
- Scope: `package.json`, `next.config.ts`, `components.json`, `src/app/{globals.css,layout.tsx,page.tsx}`, `src/components/{ui/*,theme-toggle.tsx}`, `src/lib/utils*.ts`, `vitest.config.ts`, `playwright.config.ts`, `e2e/`, `.github/workflows/ci.yml`, `.env.example`, `.gitignore`, `README.md`, `LICENSE`, `docs/adr/0000-template.md`

Reasoning / RCA / research:
    - Fresh rewrite rather than an in-place port: the previous Python stack needed a paid app host plus a hosted Postgres/auth service, and the goal is zero-cost hosting on Vercel Hobby + Neon free tier. Stack choices (Next.js 16 Cache Components, Neon + Drizzle, Better Auth, GitHub Actions cron) follow the plan's Key Technical Decisions; each gets its ADR in the unit that introduces it.
    - shadcn `radix-nova` preset (Radix primitives) over the default Base UI preset: Radix is the more mature primitive set for menus, dialogs and sheets. Neutral base, oklch CSS variables, no `tailwind.config` (Tailwind v4 CSS-first).
    - Theme: cool-slate neutrals with one cobalt accent (ring, chart-1, sidebar-primary), no pure black/white surfaces. Gain/loss are tokens (`--gain`, `--loss`, used as `text-gain`, `bg-gain/10`) so a `data-palette="cb"` attribute on `<html>` swaps green/red for a colorblind-safe blue/orange pair without touching components. Tints come from Tailwind opacity modifiers, so no separate `*-muted` tokens. All gain/loss, muted-foreground and destructive pairs measured at >= 4.9:1 contrast in both modes.
    - `typecheck` runs `next typegen && tsc --noEmit`, not bare `tsc`: the layout uses Next's generated global `LayoutProps`, which only exists after typegen, so bare `tsc` fails in a clean CI checkout.
    - Owner decisions recorded in `tasks/todo.md` (contributors can create buckets, dividends net of withholding, US history import, doc-review fixes folded into units). U2's adopted fixes landed here: gitleaks job in CI; `.gitignore` covers `.env*` (except `.env.example`), `.env.spike.local`, `scripts/spike/out/`, `.claude/worktrees/`.

Implementation summary:
    - `create-next-app@16.4.5` scaffolded in a scratch dir and moved in (it refuses non-empty dirs); template SVGs dropped. Its `next.config.ts` already sets `cacheComponents: true` and `partialPrefetching: true` explicitly, and wires Tailwind via `@tailwindcss/turbopack` instead of PostCSS.
    - shadcn components added: button, card, table, tabs, badge, dropdown-menu, dialog, sheet, sonner, skeleton, tooltip, chart, input, label, select, separator. They import `cn` from shadcn's `cn` package (clsx + tailwind-merge replacement).
    - Layout: Geist/Geist Mono via `next/font`, fixed the preset's self-referential `--font-sans` to point at `--font-geist-sans`; next-themes (class, system default), `suppressHydrationWarning`, TooltipProvider, Sonner toaster. Placeholder home page with a theme toggle and sample gain/loss badges.
    - Vitest with `@/` alias and a `cn()` sanity test; Playwright config (no browsers downloaded) builds and starts the app unless `E2E_BASE_URL` is set.
    - Verified: typecheck, lint, test (2 passed), build all exit 0; `pnpm dev` served `/` with HTTP 200; browser check confirmed light, dark, and cb palette computed colors switch as intended.

Follow-ups deferred:
    - Playwright browsers not installed and no e2e specs yet: smoke test lands in U22.
    - README Setup section is a placeholder until U22.
    - No `CLAUDE.md` created; devlog discipline lives in `AGENTS.md` (which `next dev` also maintains).

### 2026-11-11 — Devlog initialized via `/setup-devlog`

- Type: chore
- Scope: `DEVLOG.md`, `AGENTS.md`

Reasoning / RCA / research:
    - The rewrite spans 23 units over several sessions; decisions, adopted review fixes and failed approaches need one scannable record next to the code.
    - Committed rather than gitignored: the plan's output structure lists `DEVLOG.md` in the repo, and the decision log is part of the open-source project.

Implementation summary:
    - Created DEVLOG.md from the setup-devlog template (sample entries dropped).
    - Appended the devlog discipline section to `AGENTS.md`. No `CLAUDE.md` exists, and the skill does not auto-create one.
