import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { corporateActions, dividends, instruments, priceLatest, pricesDaily } from "@/db/schema";
import { yahooSymbolFor } from "./symbols";
import {
  chart,
  quoteSummary,
  spark,
  toRaw,
  YahooError,
  YahooNotFound,
  YahooRateLimited,
  type Chart,
  type Split,
} from "./yahoo";

// Prices are fetched on cron and served from the DB (docs/adr/0006).

type Instrument = typeof instruments.$inferSelect;

/** Per-symbol quote source used when Yahoo fails (U6 plugs the MCP quote tool in here). */
export type QuoteFallback = (instruments: Instrument[]) => Promise<Map<string, number>>;
const noFallback: QuoteFallback = async () => new Map();

/** 429 after retries, or 401/403 (Yahoo turning away datacenter IPs): stop calling Yahoo this run. */
const blocked = (e: unknown) =>
  e instanceof YahooRateLimited || (e instanceof YahooError && (e.status === 401 || e.status === 403));

const num = (x: number) => String(Number(x.toFixed(6)));
const usable = (p: number | undefined | null): p is number => typeof p === "number" && Number.isFinite(p) && p > 0;

export type RefreshResult = { yahoo: number; fallback: number; unavailable: number; kept: number };

/**
 * Refresh price_latest. Yahoo spark batch first; symbols missing from the batch get a
 * per-symbol chart call to tell "unknown symbol" (definitive 404) from a transient gap.
 * Anything Yahoo could not price goes to `fallback`. Instruments nobody priced keep their
 * last stored price; price_unavailable is set only on a definitive 404 that fallback also missed.
 */
export async function refreshLatest(
  list: Instrument[],
  { fallback = noFallback }: { fallback?: QuoteFallback } = {},
): Promise<RefreshResult> {
  const now = new Date();
  const priced = new Map<string, { price: number; time: Date; prevClose: number | null }>();
  const notFound = new Set<string>();
  const bySymbol = new Map(list.map((i) => [yahooSymbolFor(i), i]));

  let limited = false;
  try {
    const quotes = await spark([...bySymbol.keys()]);
    for (const [sym, q] of quotes) {
      const i = bySymbol.get(sym);
      if (i) priced.set(i.id, { price: q.price, time: q.time ?? now, prevClose: q.prevClose });
    }
  } catch (e) {
    limited = blocked(e);
    if (limited) console.warn(`[prices] Yahoo blocked spark (${(e as Error).message}); using fallback`);
    else console.error("[prices] spark failed", e);
  }

  for (const [sym, i] of bySymbol) {
    if (priced.has(i.id) || limited) continue;
    try {
      const c = await chart(sym, { range: "5d" });
      if (usable(c.price)) priced.set(i.id, { price: c.price, time: c.priceTime ?? now, prevClose: c.prevClose });
    } catch (e) {
      if (e instanceof YahooNotFound) notFound.add(i.id);
      else if (blocked(e)) limited = true; // stop hammering; rest go to fallback
      else console.error(`[prices] chart ${sym} failed`, e);
    }
  }

  const missing = list.filter((i) => !priced.has(i.id));
  const fb = missing.length ? await fallback(missing) : new Map<string, number>();

  const rows = [
    ...[...priced].map(([id, q]) => ({
      instrumentId: id,
      price: num(q.price),
      asOf: q.time,
      source: "yahoo" as const,
      prevClose: usable(q.prevClose) ? num(q.prevClose) : null,
    })),
    // LTP carries no previous close: null here, and the upsert keeps the stored one.
    ...[...fb]
      .filter(([id, p]) => usable(p) && !priced.has(id))
      .map(([id, p]) => ({ instrumentId: id, price: num(p), asOf: now, source: "mcp" as const, prevClose: null })),
  ];
  if (rows.length) {
    await db
      .insert(priceLatest)
      .values(rows)
      .onConflictDoUpdate({
        target: priceLatest.instrumentId,
        set: {
          price: sql`excluded.price`,
          asOf: sql`excluded.as_of`,
          source: sql`excluded.source`,
          prevClose: sql`coalesce(excluded.prev_close, ${priceLatest.prevClose})`,
        },
      });
  }

  const pricedIds = rows.map((r) => r.instrumentId);
  const unavailable = [...notFound].filter((id) => !pricedIds.includes(id));
  if (pricedIds.length) {
    await db.update(instruments).set({ priceUnavailable: false }).where(inArray(instruments.id, pricedIds));
  }
  if (unavailable.length) {
    await db.update(instruments).set({ priceUnavailable: true }).where(inArray(instruments.id, unavailable));
  }
  return {
    yahoo: priced.size,
    fallback: rows.length - priced.size,
    unavailable: unavailable.length,
    kept: list.length - rows.length - unavailable.length,
  };
}

/**
 * Fetch daily history and store it RAW (Yahoo's split adjustment undone). New split or
 * dividend events are upserted; if any appear on a partial-range fetch, the full history
 * (range=max) is re-fetched so every stored bar stays on one raw basis.
 */
export async function backfillHistory(
  i: Instrument,
  { range = "max" }: { range?: string } = {},
): Promise<{ bars: number; newEvents: number; refetched: boolean }> {
  let c: Chart;
  try {
    c = await chart(yahooSymbolFor(i), { range });
  } catch (e) {
    if (e instanceof YahooNotFound) {
      await db.update(instruments).set({ priceUnavailable: true }).where(eq(instruments.id, i.id));
      return { bars: 0, newEvents: 0, refetched: false };
    }
    throw e;
  }

  const newEvents = await upsertEvents(i, c);
  if (newEvents > 0 && range !== "max") {
    const full = await backfillHistory(i, { range: "max" });
    return { ...full, newEvents: full.newEvents + newEvents, refetched: true };
  }

  // Use every known action (stored ∪ fetched) so a short window still sees later splits.
  const raw = toRaw(c, await storedSplits(i.id));
  const rows = raw.bars.map((b) => ({
    instrumentId: i.id,
    date: b.date,
    open: b.open == null ? null : num(b.open),
    high: b.high == null ? null : num(b.high),
    low: b.low == null ? null : num(b.low),
    close: num(b.close),
    adjClose: b.adjClose == null ? null : num(b.adjClose),
    volume: b.volume == null ? null : String(b.volume),
  }));
  for (let k = 0; k < rows.length; k += 1000) {
    await db
      .insert(pricesDaily)
      .values(rows.slice(k, k + 1000))
      .onConflictDoUpdate({
        target: [pricesDaily.instrumentId, pricesDaily.date],
        set: {
          open: sql`excluded.open`,
          high: sql`excluded.high`,
          low: sql`excluded.low`,
          close: sql`excluded.close`,
          adjClose: sql`excluded.adj_close`,
          volume: sql`excluded.volume`,
        },
      });
  }
  return { bars: rows.length, newEvents, refetched: false };
}

// Splits and bonuses both shrink the per-share basis, and Yahoo adjusts for both.
async function storedSplits(instrumentId: string): Promise<Split[]> {
  const rows = await db.select().from(corporateActions).where(eq(corporateActions.instrumentId, instrumentId));
  return rows.map((s) => ({ date: s.exDate, numerator: Number(s.numerator), denominator: Number(s.denominator) }));
}

/** Insert splits/dividends not yet stored. Existing rows (possibly owner-reclassified) are never touched. */
async function upsertEvents(i: Instrument, c: Chart): Promise<number> {
  let added = 0;
  if (c.splits.length) {
    const ins = await db
      .insert(corporateActions)
      .values(
        c.splits.map((s) => ({
          instrumentId: i.id,
          exDate: s.date,
          numerator: String(s.numerator),
          denominator: String(s.denominator),
        })),
      )
      .onConflictDoNothing()
      .returning({ id: corporateActions.id });
    added += ins.length;
  }
  if (c.dividends.length) {
    // Raw per-share amount needs ALL splits after the ex-date, so combine stored + fetched.
    const raw = toRaw({ bars: [], dividends: c.dividends }, await storedSplits(i.id)).dividends;
    const ins = await db
      .insert(dividends)
      .values(
        raw.map((d) => ({
          instrumentId: i.id,
          exDate: d.date,
          amountPerShare: num(d.amount),
          currency: i.currency,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: dividends.id });
    added += ins.length;
  }
  return added;
}

/** Sector/industry/market cap from quoteSummary. Owner-overridden sectors are never overwritten. */
export async function enrichInstrument(i: Instrument) {
  const s = await quoteSummary(yahooSymbolFor(i));
  const set: Partial<Instrument> = {};
  if (s.marketCap != null) set.marketCap = String(s.marketCap);
  // Broker feeds carry only the trading symbol; take the company name from Yahoo once.
  if (s.name && (!i.name || i.name === i.brokerSymbol)) set.name = s.name;
  if (!i.sectorOverridden) {
    if (s.sector) set.sector = s.sector;
    if (s.industry) set.industry = s.industry;
  }
  if (Object.keys(set).length) await db.update(instruments).set(set).where(eq(instruments.id, i.id));
  return s;
}
