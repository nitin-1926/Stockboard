import { between, sql } from "drizzle-orm";
import { db } from "@/db";
import { fxDaily } from "@/db/schema";
import { chart } from "./yahoo";

// USD→INR from ECB via Frankfurter v1; Yahoo USDINR=X as fallback. See docs/adr/0007.
const FRANKFURTER = "https://api.frankfurter.dev/v1";
const DAY = 86_400_000;

export const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const today = () => new Date().toISOString().slice(0, 10);

async function frankfurter(path: string) {
  const res = await fetch(`${FRANKFURTER}/${path}?base=USD&symbols=INR`);
  if (!res.ok) throw new Error(`frankfurter ${path}: HTTP ${res.status}`);
  return res.json();
}

/** Rate for a date or "latest". Frankfurter returns the previous business day for weekends/holidays. */
export async function rateOn(date: string | "latest"): Promise<{ date: string; rate: number }> {
  const body = await frankfurter(date);
  return { date: body.date, rate: body.rates.INR };
}

/** Business-day rates in [from, to] (weekends/holidays absent). Frankfurter first, Yahoo fallback. */
export async function fetchSeries(from: string, to: string): Promise<{ map: Map<string, number>; source: string }> {
  try {
    const body = await frankfurter(`${from}..${to}`);
    const map = new Map<string, number>(
      Object.entries(body.rates as Record<string, { INR: number }>).map(([d, r]) => [d, r.INR]),
    );
    if (map.size) return { map, source: "frankfurter" };
    throw new Error("frankfurter: empty series");
  } catch (e) {
    const c = await chart("USDINR=X", {
      period1: new Date(`${from}T00:00:00Z`),
      period2: new Date(Date.parse(`${to}T00:00:00Z`) + DAY),
    }).catch(() => {
      throw e; // surface the primary failure if the fallback also fails
    });
    return { map: new Map(c.bars.map((b) => [b.date, b.close])), source: "yahoo" };
  }
}

/** Every calendar date in [from, to] gets the latest known rate on or before it. Dates before the first rate are skipped. */
export function forwardFill(rates: Map<string, number>, from: string, to: string) {
  const known = [...rates.entries()].sort(([a], [b]) => a.localeCompare(b));
  const out: { date: string; rate: number; filled: boolean }[] = [];
  let k = 0;
  let last: number | undefined;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    while (k < known.length && known[k][0] <= d) last = known[k++][1];
    if (last !== undefined) out.push({ date: d, rate: last, filled: !rates.has(d) });
  }
  return out;
}

async function fillAndUpsert(from: string, to: string) {
  // Start a week early so a range opening on a weekend/holiday has a rate to carry forward.
  const { map, source } = await fetchSeries(addDays(from, -7), to);
  const rows = forwardFill(map, from, to).map((r) => ({
    date: r.date,
    usdInr: String(r.rate),
    source: r.filled ? `${source}_ffill` : source,
  }));
  if (!rows.length) return 0;
  await db
    .insert(fxDaily)
    .values(rows)
    .onConflictDoUpdate({
      target: fxDaily.date,
      set: { usdInr: sql`excluded.usd_inr`, source: sql`excluded.source` },
    });
  return rows.length;
}

/**
 * Make sure fx_daily has a row for every date in [from, to] (to clamped to today).
 * One time-series call covers all gaps. Call it BEFORE opening a ledger transaction.
 */
export async function ensureFxRange(from: string, to: string): Promise<number> {
  const end = to > today() ? today() : to;
  if (from > end) return 0;
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(fxDaily)
    .where(between(fxDaily.date, from, end));
  const expected = Math.round((Date.parse(end) - Date.parse(from)) / DAY) + 1;
  if (n >= expected) return 0;
  return fillAndUpsert(from, end);
}

/** Cron: re-fetch the last 10 days so forward-filled rows get replaced by real ECB rates once published. */
export const refreshFx = () => fillAndUpsert(addDays(today(), -10), today());
