import { eq } from "drizzle-orm";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { yahooUrlSymbol } from "./symbols";

// chart/spark need no crumb but DO need a browser-ish User-Agent (curl's default gets 429).
const HEADERS = { "User-Agent": "Mozilla/5.0" };
const Q1 = "https://query1.finance.yahoo.com";
const Q2 = "https://query2.finance.yahoo.com";

export class YahooError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "YahooError";
  }
}
/** Definitive: symbol unknown/delisted (404 or "No data found"). */
export class YahooNotFound extends YahooError {
  name = "YahooNotFound";
}
/** 429 persisted through all retries. */
export class YahooRateLimited extends YahooError {
  name = "YahooRateLimited";
}

// Mutable so tests can zero the delay.
export const retry = { tries: 3, baseMs: 1000 };

export async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { ...HEADERS, ...headers } });
    if (res.status !== 429) return res;
    if (attempt + 1 >= retry.tries) throw new YahooRateLimited(`429 from ${url}`, 429);
    await new Promise((r) => setTimeout(r, retry.baseMs * 2 ** attempt));
  }
}

export async function json(res: Response, what: string) {
  const body = await res.json().catch(() => null);
  const err = body?.chart?.error ?? body?.spark?.error ?? body?.finance?.error ?? body?.quoteSummary?.error;
  if (res.status === 404 || err?.code === "Not Found" || /no data found/i.test(err?.description ?? "")) {
    throw new YahooNotFound(`${what}: ${err?.description ?? "not found"}`, res.status);
  }
  if (!res.ok || !body) throw new YahooError(`${what}: HTTP ${res.status} ${err?.description ?? ""}`, res.status);
  return body;
}

// ---------- chart ----------

export type Bar = {
  date: string; // exchange-local YYYY-MM-DD
  open: number | null;
  high: number | null;
  low: number | null;
  close: number; // Yahoo: split-adjusted back in time
  adjClose: number | null;
  volume: number | null;
};
export type Split = { date: string; numerator: number; denominator: number };
export type Dividend = { date: string; amount: number };
export type Chart = {
  symbol: string;
  currency: string;
  price: number | null;
  priceTime: Date | null;
  /** Close of the last bar before the price's market date (day change base). */
  prevClose: number | null;
  bars: Bar[];
  splits: Split[];
  dividends: Dividend[];
};

type ChartOpts = { range?: string; period1?: Date; period2?: Date };

const localDate = (ts: number, gmtoffset: number) =>
  new Date((ts + gmtoffset) * 1000).toISOString().slice(0, 10);

/**
 * Newest close strictly before `date`. Yahoo's meta `chartPreviousClose` is the close before the
 * requested RANGE (5d → five sessions back), not the previous session, so derive it from the bars.
 */
export function prevCloseBefore(bars: { date: string; close: number }[], date: string | null): number | null {
  if (!date) return null;
  const prev = bars.filter((b) => b.date < date && b.close > 0).sort((a, b) => b.date.localeCompare(a.date))[0];
  return prev?.close ?? null;
}

export async function chart(symbol: string, opts: ChartOpts = { range: "5d" }): Promise<Chart> {
  const q = new URLSearchParams({ interval: "1d", events: "div,splits" });
  // range=max silently returns MONTHLY bars (dated the 1st) despite interval=1d (live-checked
  // on SPY: 407 bars since 1993); an explicit period from the epoch returns every daily bar.
  if (opts.range === "max") opts = { period1: new Date(0), period2: new Date() };
  if (opts.range) q.set("range", opts.range);
  if (opts.period1) q.set("period1", String(Math.floor(opts.period1.getTime() / 1000)));
  if (opts.period2) q.set("period2", String(Math.floor(opts.period2.getTime() / 1000)));
  const res = await get(`${Q1}/v8/finance/chart/${yahooUrlSymbol(symbol)}?${q}`);
  return parseChart(await json(res, `chart ${symbol}`), symbol);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseChart(body: any, symbol: string): Chart {
  const r = body?.chart?.result?.[0];
  if (!r) throw new YahooNotFound(`chart ${symbol}: empty result`);
  const off: number = r.meta?.gmtoffset ?? 0;
  const q = r.indicators?.quote?.[0] ?? {};
  const adj: (number | null)[] = r.indicators?.adjclose?.[0]?.adjclose ?? [];
  const bars: Bar[] = [];
  (r.timestamp ?? []).forEach((ts: number, i: number) => {
    const close = q.close?.[i];
    if (close == null) return; // Yahoo emits null rows for halted/partial days
    bars.push({
      date: localDate(ts, off),
      open: q.open?.[i] ?? null,
      high: q.high?.[i] ?? null,
      low: q.low?.[i] ?? null,
      close,
      adjClose: adj[i] ?? null,
      volume: q.volume?.[i] ?? null,
    });
  });
  // Event dates come from the `date` field, not the object key.
  const splits: Split[] = Object.values(r.events?.splits ?? {}).map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s: any) => ({ date: localDate(s.date, off), numerator: s.numerator, denominator: s.denominator }),
  );
  const dividends: Dividend[] = Object.values(r.events?.dividends ?? {}).map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (d: any) => ({ date: localDate(d.date, off), amount: d.amount }),
  );
  const t = r.meta?.regularMarketTime;
  return {
    symbol: r.meta?.symbol ?? symbol,
    currency: r.meta?.currency ?? "",
    price: r.meta?.regularMarketPrice ?? bars.at(-1)?.close ?? null,
    priceTime: t ? new Date(t * 1000) : null,
    prevClose: prevCloseBefore(bars, t ? localDate(t, off) : (bars.at(-1)?.date ?? null)),
    bars: bars.sort((a, b) => a.date.localeCompare(b.date)),
    splits: splits.sort((a, b) => a.date.localeCompare(b.date)),
    dividends: dividends.sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/** Cumulative split factor for everything strictly after `date` (a split's own ex-date bar is already post-split). */
export function splitFactorAfter(date: string, splits: Split[]): number {
  return splits.reduce((f, s) => (s.date > date ? (f * s.numerator) / s.denominator : f), 1);
}

/**
 * Undo Yahoo's back-adjustment: raw = adjusted × factor of later splits. Volume is
 * adjusted the other way. Dividend amounts are on the same adjusted basis, so they
 * get the same treatment. adjClose is left as Yahoo's (informational only).
 */
export function toRaw(c: Pick<Chart, "bars" | "dividends">, splits: Split[]) {
  const mul = (x: number | null, f: number) => (x == null ? null : x * f);
  return {
    bars: c.bars.map((b) => {
      const f = splitFactorAfter(b.date, splits);
      return {
        ...b,
        open: mul(b.open, f),
        high: mul(b.high, f),
        low: mul(b.low, f),
        close: b.close * f,
        volume: b.volume == null ? null : Math.round(b.volume / f),
      };
    }),
    dividends: c.dividends.map((d) => ({ ...d, amount: d.amount * splitFactorAfter(d.date, splits) })),
  };
}

// ---------- spark (batch latest) ----------

export type SparkQuote = { price: number; time: Date | null; prevClose: number | null };

/** Latest price per symbol, ≤20 symbols per request. Unknown symbols are simply absent. */
export async function spark(symbols: string[]): Promise<Map<string, SparkQuote>> {
  const out = new Map<string, SparkQuote>();
  for (let i = 0; i < symbols.length; i += 20) {
    const chunk = symbols.slice(i, i + 20);
    const res = await get(
      `${Q1}/v7/finance/spark?symbols=${chunk.map(yahooUrlSymbol).join(",")}&range=5d&interval=1d`,
    );
    let body;
    try {
      body = await json(res, "spark");
    } catch (e) {
      if (e instanceof YahooNotFound) continue; // every symbol in the chunk unknown
      throw e;
    }
    for (const r of body.spark?.result ?? []) {
      const resp = r.response?.[0];
      const closes: (number | null)[] = resp?.indicators?.quote?.[0]?.close ?? [];
      const price = resp?.meta?.regularMarketPrice ?? closes.filter((c) => c != null).at(-1);
      if (typeof price !== "number" || !(price > 0)) continue;
      const t = resp?.meta?.regularMarketTime;
      const off: number = resp?.meta?.gmtoffset ?? 0;
      const bars = ((resp?.timestamp ?? []) as number[]).flatMap((ts, k) =>
        closes[k] == null ? [] : [{ date: localDate(ts, off), close: closes[k]! }],
      );
      out.set(r.symbol, {
        price,
        time: t ? new Date(t * 1000) : null,
        prevClose: prevCloseBefore(bars, t ? localDate(t, off) : null),
      });
    }
  }
  return out;
}

// ---------- quoteSummary (cookie + crumb) ----------

export type Crumb = { crumb: string; cookie: string };
const CRUMB_KEY = "yahoo_crumb";

// Cached in `settings` so serverless invocations share one crumb. Object so tests can spy.
export const crumbStore = {
  async load(): Promise<Crumb | null> {
    const [row] = await db.select().from(settings).where(eq(settings.key, CRUMB_KEY));
    return (row?.value as Crumb | undefined) ?? null;
  },
  async save(c: Crumb): Promise<void> {
    await db
      .insert(settings)
      .values({ key: CRUMB_KEY, value: c })
      .onConflictDoUpdate({ target: settings.key, set: { value: c } });
  },
};

async function freshCrumb(): Promise<Crumb> {
  const fc = await fetch("https://fc.yahoo.com", { headers: HEADERS, redirect: "manual" });
  const cookie = fc.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith("A3="));
  if (!cookie) throw new YahooError("crumb: fc.yahoo.com set no A3 cookie");
  const res = await get(`${Q2}/v1/test/getcrumb`, { Cookie: cookie });
  const crumb = (await res.text()).trim();
  if (!res.ok || !crumb || crumb.includes("<")) throw new YahooError(`crumb: HTTP ${res.status}`, res.status);
  const c = { crumb, cookie };
  await crumbStore.save(c);
  return c;
}

export type Summary = {
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  name: string | null;
  currency: string | null;
};

export async function quoteSummary(symbol: string): Promise<Summary> {
  let c = (await crumbStore.load()) ?? (await freshCrumb());
  const url = (crumb: string) =>
    `${Q2}/v10/finance/quoteSummary/${yahooUrlSymbol(symbol)}?modules=assetProfile,price&crumb=${encodeURIComponent(crumb)}`;
  let res = await get(url(c.crumb), { Cookie: c.cookie });
  if (res.status === 401) {
    c = await freshCrumb(); // stale crumb: refetch once
    res = await get(url(c.crumb), { Cookie: c.cookie });
  }
  const r = (await json(res, `quoteSummary ${symbol}`)).quoteSummary?.result?.[0];
  if (!r) throw new YahooNotFound(`quoteSummary ${symbol}: empty result`);
  return {
    sector: r.assetProfile?.sector || null,
    industry: r.assetProfile?.industry || null,
    marketCap: r.price?.marketCap?.raw ?? null,
    name: r.price?.longName ?? r.price?.shortName ?? null,
    currency: r.price?.currency ?? null,
  };
}
