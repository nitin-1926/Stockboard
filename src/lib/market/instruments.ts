import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { instruments, priceLatest } from "@/db/schema";
import { baseSymbol, type SearchHit } from "./search";
import { yahooSymbolFor } from "./symbols";
import { chart, YahooError } from "./yahoo";

type Instrument = typeof instruments.$inferSelect;

/**
 * Find-or-create by (market, broker_symbol), the key U10/U11 use. An existing row
 * (from a sync or import) wins; its name/exchange are never overwritten here.
 */
export async function findOrCreateInstrument(h: SearchHit): Promise<Instrument> {
  const brokerSymbol = baseSymbol(h);
  await db
    .insert(instruments)
    .values({
      market: h.market,
      exchange: h.exchange,
      brokerSymbol,
      yahooSymbol: h.symbol,
      name: h.name,
      currency: h.currency,
      assetClass: h.type,
    })
    .onConflictDoNothing();
  const [row] = await db
    .select()
    .from(instruments)
    .where(and(eq(instruments.market, h.market), eq(instruments.brokerSymbol, brokerSymbol)));
  return row;
}

/**
 * On-demand latest price (Yahoo chart's regularMarketPrice, which is the last close
 * while the market is shut). Stored in price_latest too, so the watchlist shows a
 * current price before the next cron refresh. Null when Yahoo has nothing.
 */
export async function fetchLatestPrice(i: Instrument): Promise<{ price: number; asOf: Date } | null> {
  try {
    const c = await chart(yahooSymbolFor(i), { range: "5d" });
    if (c.price == null || !(c.price > 0)) return null;
    const q = { price: c.price, asOf: c.priceTime ?? new Date() };
    const price = String(Number(q.price.toFixed(6)));
    await db
      .insert(priceLatest)
      .values({ instrumentId: i.id, price, asOf: q.asOf, source: "yahoo", prevClose: c.prevClose == null ? null : String(c.prevClose) })
      .onConflictDoUpdate({
        target: priceLatest.instrumentId,
        set: {
          price: sql`excluded.price`,
          asOf: sql`excluded.as_of`,
          source: sql`excluded.source`,
          prevClose: sql`coalesce(excluded.prev_close, ${priceLatest.prevClose})`,
        },
      });
    return q;
  } catch (e) {
    if (e instanceof YahooError) return null; // not found / rate limited: the item is added without a price
    throw e;
  }
}
