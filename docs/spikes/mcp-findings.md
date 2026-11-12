# U1 spike findings — Kite (INDmoney pending)

Run: 2026-11-12 ~18:55 IST, from the owner's laptop (residential IP), one Zerodha web login shared by both token paths.
Scripts: `scripts/spike/kite-headless.mts` (live run), `scripts/spike/scrub.mts` (fixtures + leak check).
Fixtures: `src/lib/mcp/__fixtures__/kite-*.json` (scrubbed `CallToolResult`s + public `tools/list`), `src/lib/mcp/kite/__fixtures__/headless-chain.json` and `mcp-consent.html` (U7 HTTP chain).
No credentials, tokens, cookies values, ids or real holdings appear here or in the fixtures (leak check: 0 hits).

## Result per step

| Step | Result |
| --- | --- |
| A. Zerodha web login (`/api/login` → `/api/twofa`, TOTP) | pass, first attempt (twofa_types offered: `totp`, `app_code`) |
| B1. DCR `/register` | pass (201) |
| B2. Consent GET+POST `/authorize` → Kite → `/callback` → loopback `?code` | pass, fully headless, no Kite "authorize app" screen for the MCP app |
| B3. `/token` (PKCE) | pass, JWT |
| B4. MCP client (SDK v2) + read tools | pass, every call returned `structuredContent` |
| C. Kite Connect Personal (owner's app) | **blocked**: first-time "authorize app" screen (`/connect/authorize`, HTTP 200 SPA). Not bypassed. Needs one manual browser approval by the owner; then C can be rerun. |

## Kite MCP OAuth chain (observed)

```
GET  mcp.kite.trade/authorize?response_type&client_id&redirect_uri&code_challenge&code_challenge_method&state&resource
     → 200 consent HTML; Set-Cookie __Host-kite-consent-<flow> (+ Cloudflare __cf_bm, _cfuvid)
POST mcp.kite.trade/authorize  (form: flow, csrf, decision=approve)
     → 303 kite.zerodha.com/connect/login?api_key&v&redirect_params
       Set-Cookie: __Host-kite-consent-<flow> (cleared), __Host-kite-state-<flow>
POST kite.zerodha.com/api/login (user_id, password)            → 200, Set-Cookie kf_session
POST kite.zerodha.com/api/twofa (user_id, request_id, twofa_value, twofa_type=totp)
                                                                → 200, Set-Cookie user_id, public_token, enctoken
GET  kite.zerodha.com/connect/login?api_key&v&redirect_params   → 302 kite.zerodha.com/connect/finish?api_key&sess_id
GET  kite.zerodha.com/connect/finish?api_key&sess_id            → 302 mcp.kite.trade/callback?action&type&status&request_token&session_id&state
GET  mcp.kite.trade/callback?…                                  → 302 127.0.0.1:53682/callback?code&state  (state cookie cleared; stop here)
POST mcp.kite.trade/token (grant_type=authorization_code, code, code_verifier, client_id, redirect_uri, resource) → 200
```

- `flow` and `csrf` are hidden inputs in the consent form (`name="flow" value=…`, `name="csrf" value=…`); `csrf` equals the consent cookie value. `<flow>` in the cookie name is the flow id. Fixture: `mcp-consent.html` (values replaced by `FLOW_PLACEHOLDER` / `CSRF_PLACEHOLDER` / `CLIENT_ID_PLACEHOLDER`).
- `resource` = `https://mcp.kite.trade/mcp` (from `/.well-known/oauth-protected-resource`). Server validates it if sent; empty is also accepted.
- The Kite login can happen before or after consent; consent/state cookies live 600 s. Order used: consent → login → follow.
- `state` on the loopback redirect matched ours. Callback params: `code`, `state`.
- AS metadata: `grant_types_supported: [authorization_code]` (no refresh), `token_endpoint_auth_methods_supported: [none]` (public client), `code_challenge_methods_supported: [S256]`.

## DCR

- One registration with **both** `http://127.0.0.1:53682/callback` and `https://stockboard.nitingupta.xyz/api/connect/kite/callback` → **201, both accepted and echoed back**. One client_id serves the headless job (loopback, never resolved) and the manual reconnect (https).
- Response keys: `client_id, client_id_issued_at, client_name, grant_types, redirect_uris, response_types, token_endpoint_auth_method`. client_id is stateless/signed (per server source), so store once.

## Tokens and lifetimes

| Token | Lifetime observed |
| --- | --- |
| MCP JWT | `expires_in: 604799`; `exp - iat` = 168 h (7 days). `token_type: Bearer`, `scope: default`. Claims: `client_id, iss, sub, aud, exp, iat, jti, kite_user_id, session_id, scope`. No refresh token. |
| Underlying Kite session (inside MCP) | Not observable here; per server source it dies at the next 06:00 IST and tools then return `isError` "kite session has expired" (the JWT itself stays valid). Not exercised in this run — U7/U10 must verify the post-06:00 behaviour. |
| Kite Connect access_token | Not obtained (step C blocked). Documented lifetime: until next 06:00 IST. |

Store `exp` but treat the connection as valid only until the next 06:00 IST.

## MCP protocol + SDK

- `@modelcontextprotocol/client` 2.4.0, `StreamableHTTPClientTransport` + `authProvider: { token }`, `versionNegotiation: { mode: "auto" }` → negotiated **`2026-07-28`** (stateless) on first try. Server: `Kite MCP Server v0.4.0-dev36`. Capabilities: `logging`, `resources`, `tools.listChanged`, extensions `io.modelcontextprotocol/skills`, `io.modelcontextprotocol/ui`.
- `tools/list` result carries `ttlMs: 0`, `cacheScope: "public"`.
- Latency (laptop → hosted): connect 131 ms, `tools/list` 59 ms, tool calls 46–128 ms.

## Tools (hosted server exposes write tools)

| Tool | Modes | Annotations |
| --- | --- | --- |
| `portfolio` | profile, margins, holdings, positions | readOnlyHint |
| `orders` | list, history, trades, all_trades, **place, modify, cancel**, approval_status, permissions | none |
| `market` | quote, ltp, ohlc, historical, search, option_chain | readOnlyHint |
| `gtt` | list, **place, modify, delete** | none |
| `alerts` | get, **create, modify, delete** | none |
| `mutual_funds` | holdings | none |
| `session` | status, **logout** | none |
| `help` | (key) | readOnlyHint |

- `EXCLUDED_TOOLS` on the hosted server does **not** remove order/GTT/alert writes; they are listed (writes go through a browser-approval flow per server source). None were called. U6's allowlist (`tool:mode`) is therefore mandatory, and `session:logout` must be on the deny side too (it would kill the session).
- **Correction to the plan:** daily fills come from `orders` mode **`all_trades`** (all trades today, paginated). Mode `trades` is "fills for one order" and requires `order_id`.
- Full input/output schemas: `src/lib/mcp/__fixtures__/kite-tools-list.json`. Output schemas are loose (`data: array of object`, items untyped), so U6's zod item schemas must come from the fixtures below, not from `outputSchema`.

## Result envelope

- `CallToolResult` keys: `_meta`, `content`, `structuredContent` (+ `isError` on errors). `content[0]` is `text` and is exactly `JSON.stringify(structuredContent)`.
- `_meta`: `io.modelcontextprotocol/serverInfo {name, version}` and `trade.kite/app {tool, arguments}` (echoes the call args).
- Lists: `{ data: [...], pagination: { from, limit, total, has_more, returned } }`. Defaults `from 0`, `limit 100`, max 500. Verified with `limit: 2`: page 1 `has_more: true`, page 2 `from: 2`. Holdings `type=summary` is unpaginated (per schema). `orders trades` (single order) returns `{ data }` with no pagination.
- `isError`: argument validation errors come back as `isError: true`, no `structuredContent`, `content[0].text` = message (e.g. `parameter 'instruments': must be an array of 1-500 non-empty strings`). Check `isError` before parsing.

## Output shapes (field: type)

- **holdings** (`portfolio` holdings full) row: `tradingsymbol, exchange, isin, product, collateral_type, authorised_date: string; instrument_token, price, used_quantity, quantity, t1_quantity, realised_quantity, authorised_quantity, opening_quantity, collateral_quantity, average_price, last_price, close_price, pnl, day_change, day_change_percentage: number; discrepancy: boolean; mtf: { quantity, used_quantity, average_price, value, initial_margin: number }`.
- **positions** row: `tradingsymbol, exchange, product, view: string ("day" | "net"); instrument_token, quantity, overnight_quantity, multiplier, average_price, close_price, last_price, value, pnl, m2m, unrealised, realised, buy_/sell_ quantity|price|value|m2m, day_buy_/day_sell_ quantity|price|value: number`. Each instrument appears once per view; do not sum views.
- **all_trades** row: `trade_id, order_id, exchange_order_id, product, transaction_type, tradingsymbol, exchange, fill_timestamp, exchange_timestamp: string; average_price, quantity, instrument_token: number`. Timestamps are ISO 8601 with `+05:30` (e.g. `2026-11-12T13:51:59+05:30`), so U11b's `executedAt` offset requirement is met directly. One order can have several trades.
- **orders list** row: Kite order object (`account_id, placed_by, order_id, status, order_timestamp, …, quantity, filled_quantity, pending_quantity, …, tags: null, guid`).
- **margins**: `{ equity, commodity }`, each `{ enabled, net, available { adhoc_margin, cash, collateral, intraday_payin, live_balance, opening_balance }, utilised { debits, exposure, m2m_realised, m2m_unrealised, option_premium, payout, span, holding_sales, turnover, liquid_collateral, stock_collateral, delivery } }`.
- **profile**: `user_id, user_name, user_shortname, avatar_url, user_type, email, broker, meta { demat_consent }, products[], order_types[], exchanges[]`.
- **ltp**: `{ data: { "EXCH:SYMBOL": { instrument_token, last_price } }, meta: { as_of_available, missing_instruments[], partial, requested_count, returned_count, timestamp_note } }`. `data` is an object keyed by instrument, not an array. No timestamp (use `quote` mode if needed).

## trade_id vs Console (U11a `sourceRef`)

- `trade_id` is a **numeric string of variable length** (7 and 9 digits seen in one day), unique within the day's list. This is the exchange trade number Kite passes through; Console's tradebook `trade_id` column is the same exchange trade number, so `fill:<trade_id>` should match a Console row.
- **Not proven byte-for-byte**: Console's tradebook updates T+1, so the owner (or U10) should confirm one of today's fills against tomorrow's Console export. Exchange trade numbers are not globally unique across exchanges/days, so the U11a fallback key (`exchange + trade date + trade_id`) is the safer `sourceRef`.
- The repo's `src/lib/ledger/__fixtures__/console-tradebook.csv` is synthetic (8-digit ids), so it proves nothing about real formats. Console rows also carry `order_id`; whether it equals Kite's `order_id` (15 digits here) or the `exchange_order_id` (16 digits) is unconfirmed — check in the same Console comparison.

## T+1 / quantity semantics (observed today)

- `quantity == opening_quantity - used_quantity` for every holding, and `realised_quantity == quantity`. So **today's sells are already deducted** from holdings `quantity` (`used_quantity` = sold today), and the matching net position is negative (`quantity == -used_quantity`). Do not subtract net negative positions again.
- **Today's buys are not in holdings**: a CNC buy today appeared only as a positive `net` position. `t1_quantity` was 0 for all rows (no T+1-pending shares today); per Kite semantics it holds yesterday's buys until settlement.
- A holding listed under **BSE was sold on NSE**: the position row's `exchange` differs from the holding's. Match positions to holdings by `tradingsymbol`/ISIN, not `exchange:tradingsymbol`.
- `authorised_quantity` equals `opening_quantity` (eDIS/DDPI authorisation for the day, not reduced by today's sells); `authorised_date` is an ISO timestamp.
- Snapshot rule for U10: `qty = quantity + t1_quantity + max(0, net CNC position quantity)` per instrument. Not observed today: a same-day buy of an already-held symbol (whether holdings `quantity` includes it); U10 should log when it happens.
- Day positions `buy_quantity`/`sell_quantity` matched the per-symbol sum of `all_trades`.

## Kite Connect Personal (owner's app)

- Chain with the same jar: `connect/login?v&api_key` → 302 `connect/finish?api_key&sess_id` → 302 `connect/authorize?api_key&sess_id` → **200** (SPA, title "Login to Kite by Zerodha…"). This is Kite's one-time app-authorization screen; the spike did not post it.
- Owner action: open `https://kite.zerodha.com/connect/login?v=3&api_key=<your app key>` in a browser, log in, click Authorize once. After that, rerunning the spike (one more login) completes C: `/session/token`, REST shape capture, and the Personal-tier `quote/ltp` check (expected to fail: no market data on Personal).
- REST shapes: the MCP server is a passthrough of the Kite Connect Go client (`client.GetUserProfile()` etc., per source), so field names match Kite Connect REST; MCP only wraps lists in `{data, pagination}`.

## Latency

| Path | Time |
| --- | --- |
| Consent (metadata + GET/POST `/authorize`) | 0.46 s |
| Zerodha login (`/api/login` 278 ms + `/api/twofa` 51 ms; rest was the TOTP window wait) | 1.8 s total |
| Kite redirects + `/callback` + `/token` | 0.35 s |
| MCP connect + `tools/list` | 0.19 s |
| 11 read calls | 0.05–0.13 s each |
| Kite Connect redirects (to authorize screen) | 0.23 s |

## Gate decision (Kite): **MCP-first — provisional GO**

- Headless reliability: the whole chain ran unattended on the first attempt with one login and no authorize screen; every step is a plain redirect/cookie hop, easy to fixture-test (U7).
- Data completeness: holdings (incl. `t1_quantity`, `used_quantity`), positions (day/net), margins, today's fills with `trade_id` and offset timestamps (`all_trades`), and `ltp` (market data, which Kite Connect Personal lacks) all present. Kite Connect Personal would give the same account fields but no market data.
- Hosted-session risk: grants live in server memory (restart ⇒ "kite session has expired" mid-day). Mitigated by U6's `SessionExpiredError` → stale + U10's "re-login once and retry". Kite Connect REST has no such dependency.
- Schema stability: the server is a dev build (`v0.4.0-dev36`) with loose output schemas; U6's zod schemas per tool/mode must fail loudly. Kite Connect REST is the more stable contract.
- Fallback stays cheap: same headless login, only the token exchange differs (`/session/token` with checksum). Unblock it with the one-time authorize above so it is ready.
- **Condition:** the adopted fix requires the headless chain to also succeed from a Vercel function / GitHub runner. **Deferred to U7 deploy verification** (running it now would mean putting credentials in cloud env). Risk: Zerodha/Cloudflare may challenge or rate-limit datacenter IPs on `/api/login` (`__cf_bm` cookies are already set), or flag a login from a new location. If it fails there, options: run the login in the GitHub runner with a different IP pool, or switch the daily job to the manual-reconnect banner.

## Plan "Deferred to Implementation" answers (Kite)

- Hosted `EXCLUDED_TOOLS`: read modes all available; fills are `orders` `all_trades` (not `trades`). Write tools are also exposed.
- Kite first-time screen: none for the Kite MCP app on this account (it may have been approved before; a brand-new account could still see one → U7's `redirect` failure + manual reconnect covers it). Yes for the owner's Personal app.
- Symbol search: Kite `market` `search` mode exists (`search_mode`, `filter_on`, `query`); not exercised.
- INDmoney items: pending (INDmoney part of U1 not run).
