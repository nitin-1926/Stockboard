// Broker symbol → Yahoo symbol. Returns the UNENCODED Yahoo symbol (e.g. "M&M.NS");
// encode with `yahooUrlSymbol` only when building a URL.

// Renamed/demerged symbols Yahoo 404s on under the broker's old name. Keyed by "EXCHANGE:SYMBOL".
export const YAHOO_OVERRIDES: Record<string, string> = {
  "NSE:TATAMOTORS": "TMPV.NS",
  "NSE:MCDOWELL-N": "UNITDSPR.NS",
};

// NSE series suffixes Kite appends (trade-to-trade, SME, etc.). Real hyphenated
// symbols like BAJAJ-AUTO or MCDOWELL-N must survive, so this list stays explicit.
const SERIES_SUFFIX = /-(BE|BZ|BL|SM|ST)$/;

type SymbolInput = {
  market: "IN" | "US";
  exchange: string;
  brokerSymbol: string;
  yahooSymbol?: string | null;
  yahooSymbolOverride?: string | null;
};

export function toYahooSymbol({ market, exchange, brokerSymbol }: SymbolInput): string {
  const sym = brokerSymbol.trim().toUpperCase();
  if (sym.startsWith("^") || sym.includes("=")) return sym; // indices, FX pairs
  const ex = exchange.toUpperCase();
  const override = YAHOO_OVERRIDES[`${ex}:${sym}`];
  if (override) return override;
  if (market === "US") return sym.replace(/\./g, "-");
  const base = sym.replace(SERIES_SUFFIX, "");
  return `${base}${ex === "BSE" ? ".BO" : ".NS"}`;
}

/** Owner override (DB) > stored yahoo_symbol > computed mapping. */
export function yahooSymbolFor(i: SymbolInput): string {
  return i.yahooSymbolOverride || i.yahooSymbol || toYahooSymbol(i);
}

/** URL-safe form: `&` → %26, `^` → %5E, `=` → %3D. */
export const yahooUrlSymbol = (s: string) => encodeURIComponent(s);
