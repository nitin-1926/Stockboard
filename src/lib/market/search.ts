import type { Currency, Market } from "@/lib/returns/types";
import { get, json } from "./yahoo";

// Symbol search for adding watch items. Yahoo's /v1/finance/search needs no crumb
// (checked live 2026-11-11), only the browser User-Agent that `get` already sends.

export type SearchHit = {
  /** Yahoo symbol, e.g. "TCS.NS", "AAPL", "BRK-B". */
  symbol: string;
  name: string;
  /** Display exchange: NSE, BSE, NASDAQ, NYSE, NYSE Arca, ... */
  exchange: string;
  market: Market;
  currency: Currency;
  type: "equity" | "etf";
};

// Yahoo exchange code → our market + display label. Everything else (Toronto, Frankfurt, OTC, ...) is dropped.
const EXCHANGES: Record<string, { market: Market; label: string }> = {
  NSI: { market: "IN", label: "NSE" },
  BSE: { market: "IN", label: "BSE" },
  NMS: { market: "US", label: "NASDAQ" },
  NGM: { market: "US", label: "NASDAQ" },
  NCM: { market: "US", label: "NASDAQ" },
  NYQ: { market: "US", label: "NYSE" },
  ASE: { market: "US", label: "NYSE American" },
  PCX: { market: "US", label: "NYSE Arca" },
  BTS: { market: "US", label: "Cboe BZX" },
};
const TYPES: Record<string, SearchHit["type"]> = { EQUITY: "equity", ETF: "etf" };

/** Base ticker: "TCS.NS" → "TCS", "BRK-B" → "BRK.B" (the broker's spelling). */
export function baseSymbol(h: Pick<SearchHit, "symbol" | "market">) {
  return h.market === "IN" ? h.symbol.replace(/\.(NS|BO)$/, "") : h.symbol.replace(/-/g, ".");
}

/** Equities/ETFs on NSE/BSE/US exchanges only; a dual-listed Indian stock keeps its NSE line. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseSearch(body: any): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const q of body?.quotes ?? []) {
    const ex = EXCHANGES[q?.exchange];
    const type = TYPES[q?.quoteType];
    if (!ex || !type || typeof q.symbol !== "string") continue;
    hits.push({
      symbol: q.symbol,
      name: String(q.longname || q.shortname || q.symbol).trim(),
      exchange: ex.label,
      market: ex.market,
      currency: ex.market === "IN" ? "INR" : "USD",
      type,
    });
  }
  const onNse = new Set(hits.filter((h) => h.symbol.endsWith(".NS")).map(baseSymbol));
  return hits.filter((h) => !(h.symbol.endsWith(".BO") && onNse.has(baseSymbol(h))));
}

export async function searchSymbols(query: string): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const params = new URLSearchParams({ q, quotesCount: "10", newsCount: "0", listsCount: "0" });
  const res = await get(`https://query1.finance.yahoo.com/v1/finance/search?${params}`);
  return parseSearch(await json(res, `search ${q}`));
}

/**
 * Paste import resolution: only an exact ticker match counts (a name or a fuzzy hit
 * would silently add the wrong stock). A hint picks the market; without one a ticker
 * listed in both (INFY) resolves to India, since pasted lists come from Kite.
 */
export function exactMatch(token: string, hits: SearchHit[], hint?: Market): SearchHit | null {
  const want = token.trim().toUpperCase().replace(/\.(NS|BO)$/, "");
  const exact = hits.filter((h) => baseSymbol(h).toUpperCase() === want || h.symbol.toUpperCase() === token.trim().toUpperCase());
  const pool = hint ? exact.filter((h) => h.market === hint) : exact;
  return pool.find((h) => h.market === "IN") ?? pool[0] ?? null;
}
