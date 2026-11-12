// Kite sync (U10). One run: holdings, positions, today's trades and margins through the Kite
// MCP (one connection), then, in this order:
//   instruments (first sight) → snapshot rows + broker LTP + margins (one transaction)
//   → bootstrapOpenings → ingestFills → ingestSnapshotRun → best-effort Yahoo price/history.
// Fills go in BEFORE snapshot inference, so a change a fill explains never becomes an inferred event.
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { holdingSnapshots, instruments, marginsLatest, priceLatest, pricesDaily } from "@/db/schema";
import { setStatus } from "@/lib/brokers/connections";
import { bootstrapOpenings, type Fill, ingestFills, ingestSnapshotRun } from "@/lib/ledger/ingest";
import { backfillHistory, enrichInstrument, refreshLatest } from "@/lib/market/prices";
import { YahooRateLimited } from "@/lib/market/yahoo";
import { toYahooSymbol } from "@/lib/market/symbols";
import { SessionExpiredError } from "@/lib/mcp/client";
import { withKite } from "@/lib/mcp/kite/auth";
import { kiteHeadlessLogin } from "@/lib/mcp/kite/headless-login";
import {
  type BrokerHolding,
  type BrokerPosition,
  getHoldings,
  getMargins,
  getPositions,
  getTodayTrades,
} from "@/lib/mcp/kite/tools";
import type { JobResult } from "./registry";

/** Today's CNC activity for one symbol, summed across exchanges (from the `day` positions view). */
type DayCnc = { exchange: string; buyQty: number; buyValue: number; sellQty: number; sellValue: number; lastPrice: number };

export interface SnapshotLine {
  symbol: string;
  exchange: string;
  qty: number;
  t1Qty: number;
  avgPrice: number;
  ltp: number | null;
  /** Held before today AND bought today: the one case U1 did not observe (see composeSnapshot). */
  topUp: boolean;
  raw: { holding?: BrokerHolding; day?: DayCnc };
}

/**
 * Snapshot qty rule (U1 findings, observed on the live account):
 * - holdings `quantity` already excludes today's sells (= opening_quantity − used_quantity);
 * - today's buys are NOT in holdings: they show only as CNC positions until the next day;
 * - `t1_quantity` holds earlier buys still settling.
 * So per symbol: qty = quantity + t1_quantity + today's CNC day-view buy qty. Day sells are never
 * subtracted again. A symbol only in positions (a new buy today) gets qty = max(0, day buys − day sells)
 * at the day buy average. Positions carry no ISIN, so they match holdings by tradingsymbol, summed across
 * exchanges (a BSE-listed holding can be sold on NSE). Non-CNC positions (MIS, NRML, MTF) are ignored.
 * Unobserved: whether a same-day buy of an already-held symbol also lands in holdings `quantity`
 * (that would double count it); such rows are flagged `topUp` and counted in sync_runs.
 */
export function composeSnapshot(holdings: BrokerHolding[], positions: BrokerPosition[]): SnapshotLine[] {
  const day = new Map<string, DayCnc>();
  for (const p of positions) {
    if (p.view !== "day" || p.product !== "CNC") continue;
    const d = day.get(p.brokerSymbol) ?? { exchange: p.exchange, buyQty: 0, buyValue: 0, sellQty: 0, sellValue: 0, lastPrice: p.lastPrice };
    d.buyQty += p.buyQty;
    d.buyValue += p.buyQty * p.buyAvg;
    d.sellQty += p.sellQty;
    d.sellValue += p.sellQty * p.sellAvg;
    day.set(p.brokerSymbol, d);
  }

  const lines: SnapshotLine[] = holdings.map((h) => {
    const d = day.get(h.brokerSymbol);
    day.delete(h.brokerSymbol);
    const held = h.qty + h.t1Qty;
    const bought = d?.buyQty ?? 0;
    const qty = held + bought;
    return {
      symbol: h.brokerSymbol,
      exchange: h.exchange,
      qty,
      t1Qty: h.t1Qty,
      avgPrice: qty > 0 ? (held * h.avgPrice + (d?.buyValue ?? 0)) / qty : h.avgPrice,
      ltp: h.lastPrice > 0 ? h.lastPrice : null,
      topUp: held > 0 && bought > 0,
      raw: d ? { holding: h, day: d } : { holding: h },
    };
  });

  for (const [symbol, d] of day) {
    // Sold with no holdings row (e.g. a fully sold holding Kite already dropped): a 0-qty row priced
    // at the sell average, so the first-sight opening isn't costed at 0.
    const avgPrice = d.buyQty > 0 ? d.buyValue / d.buyQty : d.sellQty > 0 ? d.sellValue / d.sellQty : 0;
    lines.push({
      symbol,
      exchange: d.exchange,
      qty: Math.max(0, d.buyQty - d.sellQty),
      t1Qty: 0,
      avgPrice,
      ltp: d.lastPrice > 0 ? d.lastPrice : null,
      topUp: false,
      raw: { day: d },
    });
  }
  return lines;
}

const fetchAll = () =>
  withKite(async (call) => ({
    holdings: await getHoldings(call),
    positions: await getPositions(call),
    trades: await getTodayTrades(call),
    margins: await getMargins(call),
  }));

/** Dead session → one headless login, then one retry. withKite / the login set stale / login_failed. */
async function fetchWithRelogin() {
  try {
    return await fetchAll();
  } catch (e) {
    if (!(e instanceof SessionExpiredError)) throw e;
    await kiteHeadlessLogin();
    return fetchAll();
  }
}

/** Instruments with no stored history get it backfilled, this many per run (each is a range=max fetch). */
const HISTORY_PER_RUN = 5;
const ENRICH_PER_RUN = 10;

/** Test hook: vanished-instrument detection only considers broker symbols with this prefix (shared dev DB). */
export type SyncScope = { symbolPrefix?: string };

const num = (x: number) => String(Number(x.toFixed(6)));

export async function syncKite(runId: string, { symbolPrefix }: SyncScope = {}): Promise<JobResult> {
  const data = await fetchWithRelogin();
  const takenAt = new Date();
  const lines = composeSnapshot(data.holdings, data.positions);
  const trades = data.trades.filter((t) => t.product === "CNC");

  // Instruments are reference data: find-or-create before (and outside) the transaction, as ingest's imports do.
  const exchangeOf = new Map(lines.map((l) => [l.symbol, l.exchange]));
  for (const t of trades) if (!exchangeOf.has(t.symbol)) exchangeOf.set(t.symbol, t.exchange);
  const symbols = [...exchangeOf.keys()];
  const created = symbols.length
    ? await db
        .insert(instruments)
        .values(
          [...exchangeOf].map(([brokerSymbol, exchange]) => ({
            market: "IN" as const,
            exchange,
            brokerSymbol,
            yahooSymbol: toYahooSymbol({ market: "IN", exchange, brokerSymbol }),
            name: brokerSymbol,
            currency: "INR" as const,
          })),
        )
        .onConflictDoNothing()
        .returning()
    : [];
  const idOf = new Map(
    (symbols.length
      ? await db
          .select({ id: instruments.id, symbol: instruments.brokerSymbol })
          .from(instruments)
          .where(and(eq(instruments.market, "IN"), inArray(instruments.brokerSymbol, symbols)))
      : []
    ).map((r) => [r.symbol, r.id]),
  );
  const present = new Set(lines.map((l) => idOf.get(l.symbol)!));

  // Held at its latest earlier Kite snapshot, absent now → explicit 0-qty row (ingest never synthesizes exits).
  // ponytail: DISTINCT ON over every Kite snapshot; bound it by date if the table grows large.
  const last = await db
    .selectDistinctOn([holdingSnapshots.instrumentId], {
      instrumentId: holdingSnapshots.instrumentId,
      qty: holdingSnapshots.qty,
      avgPrice: holdingSnapshots.avgPrice,
    })
    .from(holdingSnapshots)
    .innerJoin(instruments, eq(instruments.id, holdingSnapshots.instrumentId))
    .where(
      and(
        eq(holdingSnapshots.broker, "kite"),
        ne(holdingSnapshots.runId, runId),
        symbolPrefix ? sql`starts_with(${instruments.brokerSymbol}, ${symbolPrefix})` : undefined,
      ),
    )
    .orderBy(holdingSnapshots.instrumentId, desc(holdingSnapshots.takenAt));
  const vanished = last.filter((r) => Number(r.qty) > 0 && !present.has(r.instrumentId));
  // An empty holdings list while shares were held is far more likely a broker glitch than a full exit
  // (a sale shows as a 0-qty holding that day): refuse rather than infer a sell of everything.
  if (!data.holdings.length && vanished.length)
    throw new Error(`Kite returned no holdings but ${vanished.length} were held at the last sync; not inferring sells`);

  const fills: Fill[] = trades.map((t) => ({
    tradeId: t.tradeId,
    instrumentId: idOf.get(t.symbol)!,
    side: t.side === "BUY" ? "buy" : "sell",
    qty: t.qty,
    price: t.price,
    executedAt: t.executedAt,
  }));

  const equity = data.margins.equity;
  await db.transaction(async (tx) => {
    const rows = [
      ...lines.map((l) => ({
        runId,
        broker: "kite" as const,
        instrumentId: idOf.get(l.symbol)!,
        takenAt,
        qty: num(l.qty),
        t1Qty: num(l.t1Qty),
        avgPrice: num(l.avgPrice),
        ltp: l.ltp == null ? null : num(l.ltp),
        raw: l.raw,
      })),
      ...vanished.map((v) => ({
        runId,
        broker: "kite" as const,
        instrumentId: v.instrumentId,
        takenAt,
        qty: "0",
        t1Qty: "0",
        avgPrice: v.avgPrice,
        ltp: null,
        raw: { vanished: true },
      })),
    ];
    if (rows.length) await tx.insert(holdingSnapshots).values(rows);
    // Broker LTP only where the stored price is older than this snapshot: a fresher Yahoo quote stays.
    const ltps = lines.filter((l) => l.ltp != null);
    if (ltps.length)
      await tx
        .insert(priceLatest)
        .values(
          ltps.map((l) => {
            // Kite's holdings close_price is the last trading day's close; today-only buys have none.
            const close = l.raw.holding?.closePrice;
            return {
              instrumentId: idOf.get(l.symbol)!,
              price: num(l.ltp!),
              asOf: takenAt,
              source: "broker" as const,
              prevClose: close && close > 0 ? num(close) : null,
            };
          }),
        )
        .onConflictDoUpdate({
          target: priceLatest.instrumentId,
          set: {
            price: sql`excluded.price`,
            asOf: sql`excluded.as_of`,
            source: sql`excluded.source`,
            prevClose: sql`coalesce(excluded.prev_close, ${priceLatest.prevClose})`,
          },
          setWhere: sql`${priceLatest.asOf} < excluded.as_of`,
        });
    const margins = { cash: num(equity.cash), used: num(equity.utilised), net: num(equity.net), asOf: takenAt };
    await tx
      .insert(marginsLatest)
      .values({ broker: "kite", ...margins })
      .onConflictDoUpdate({ target: marginsLatest.broker, set: margins });
  });

  // Order matters: openings exclude today's fills, fills land before inference.
  const openings = await bootstrapOpenings(runId, fills);
  const filled = await ingestFills("kite", fills);
  const inferred = await ingestSnapshotRun(runId);
  await setStatus("kite", "connected", { syncedAt: takenAt });

  // Best-effort market data, outside every transaction: a Yahoo failure never fails the sync.
  let priced = 0;
  let history = 0;
  let marketErrors = 0;
  try {
    if (created.length) {
      const r = await refreshLatest(created);
      priced = r.yahoo + r.fallback;
    }
  } catch (e) {
    marketErrors++;
    console.error("[kite-sync] price refresh failed", e);
  }
  const noHistory = present.size
    ? await db
        .select()
        .from(instruments)
        .where(
          and(
            inArray(instruments.id, [...present]),
            eq(instruments.priceUnavailable, false),
            sql`not exists (select 1 from ${pricesDaily} where ${pricesDaily.instrumentId} = ${instruments.id})`,
          ),
        )
        .limit(HISTORY_PER_RUN)
    : [];
  for (const i of noHistory) {
    try {
      await backfillHistory(i);
      history++;
    } catch (e) {
      marketErrors++;
      console.error(`[kite-sync] history ${i.brokerSymbol} failed`, e);
    }
  }

  // Names + sector for instruments still showing only their symbol (a few per run; Yahoo rate-limits bursts).
  let enriched = 0;
  const unnamed = present.size
    ? await db
        .select()
        .from(instruments)
        .where(
          and(
            inArray(instruments.id, [...present]),
            sql`(${instruments.name} is null or ${instruments.name} = ${instruments.brokerSymbol})`,
          ),
        )
        .limit(ENRICH_PER_RUN)
    : [];
  for (const i of unnamed) {
    try {
      await enrichInstrument(i);
      enriched++;
    } catch (e) {
      marketErrors++;
      console.error(`[kite-sync] enrich ${i.brokerSymbol} failed`, e);
      if (e instanceof YahooRateLimited) break;
    }
  }

  return {
    counts: {
      holdings: data.holdings.length,
      snapshots: lines.length,
      new_buys: lines.filter((l) => !l.raw.holding).length,
      vanished: vanished.length,
      top_ups: lines.filter((l) => l.topUp).length,
      instruments_new: created.length,
      fills: fills.length,
      fills_new: filled.inserted,
      openings: openings.inserted,
      inferred: inferred.inserted,
      review: inferred.review,
      priced,
      history,
      enriched,
      market_errors: marketErrors,
    },
  };
}
