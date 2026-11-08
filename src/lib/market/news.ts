// Google News RSS search. Query is the quoted company name (bare tickers match noise).
import { cacheLife } from "next/cache";

export type NewsItem = {
  title: string;
  publisher: string | null;
  link: string;
  pubDate: string | null; // ISO
  sourceUrl: string | null;
};

const LOCALE = {
  IN: "hl=en-IN&gl=IN&ceid=IN:en",
  US: "hl=en-US&gl=US&ceid=US:en",
} as const;

export function newsUrl(company: string, market: "IN" | "US"): string {
  const q = `${encodeURIComponent(`"${company}"`)}+when:7d`;
  return `https://news.google.com/rss/search?q=${q}&${LOCALE[market]}`;
}

export async function fetchNews(company: string, market: "IN" | "US", limit = 20): Promise<NewsItem[]> {
  const res = await fetch(newsUrl(company, market), { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`google news: HTTP ${res.status}`);
  return parseRss(await res.text()).slice(0, limit);
}

/**
 * Symbol page news (U19), cached per (symbol, market, name) for hours across requests.
 * Never reads cookies or the actor: the caller has already authorized the page. A fetch
 * error throws out of the cache scope (nothing cached) and the caller shows a fallback.
 */
export async function getSymbolNews(symbol: string, market: "IN" | "US", name: string, limit = 8): Promise<NewsItem[]> {
  "use cache";
  cacheLife("hours");
  void symbol; // part of the cache key: two instruments sharing a name keep separate entries
  return fetchNews(newsQueryName(name), market, limit);
}

/** "Apple Inc." → "Apple", "Infosys Limited" → "Infosys": the quoted query must match how headlines name it. */
export function newsQueryName(name: string): string {
  const bare = name
    .replace(/\([^)]*\)/g, " ")
    .replace(/[.,]/g, " ")
    .replace(/\b(ltd|limited|inc|incorporated|corp|corporation|plc|co|company|class [a-c])\s*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
  return bare || name.trim();
}

const decode = (s: string) =>
  s
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&") // last, so "&amp;lt;" stays "&lt;"
    .trim();

const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : null;
};

/**
 * Minimal parser for Google News RSS (flat, well-formed items). Titles come as
 * "Headline - Publisher"; the publisher suffix is split off using <source>.
 */
export function parseRss(xml: string): NewsItem[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].flatMap(([, item]) => {
    const rawTitle = tag(item, "title");
    const link = tag(item, "link");
    if (!rawTitle || !link) return [];
    const publisher = tag(item, "source");
    const srcUrl = item.match(/<source\s+url="([^"]*)"/)?.[1];
    const suffix = publisher ? ` - ${publisher}` : null;
    const title = suffix && rawTitle.endsWith(suffix) ? rawTitle.slice(0, -suffix.length) : rawTitle;
    const pub = tag(item, "pubDate");
    const t = pub ? Date.parse(pub) : NaN;
    return [
      {
        title,
        publisher,
        link,
        pubDate: Number.isNaN(t) ? null : new Date(t).toISOString(),
        sourceUrl: srcUrl ? decode(srcUrl) : null,
      },
    ];
  });
}
