// On-demand price freshness for page renders (supplements the cron in docs/adr/0006 / 0008).
// A view calls ensureFresh(instruments) before reading price_latest: anything stale in an
// OPEN market is refreshed (Yahoo, Kite LTP fallback for IN), bounded by a time budget so
// the page never waits long. Closed markets do nothing: the last close stands.
import { createHash } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { after } from "next/server";
import { db } from "@/db";
import { type instruments, priceLatest, settings } from "@/db/schema";
import { getConnection } from "@/lib/brokers/connections";
import { isMarketOpen } from "@/lib/jobs/schedule";
import { withKite } from "@/lib/mcp/kite/auth";
import { getLtp } from "@/lib/mcp/kite/tools";
import { type QuoteFallback, refreshLatest } from "./prices";

type Instrument = typeof instruments.$inferSelect;

export type MarketStatus = { IN: { open: boolean }; US: { open: boolean } };

/** Regular-session status per market (holidays not modelled, see schedule.ts). */
export function marketStatus(now = new Date()): MarketStatus {
  return { IN: { open: isMarketOpen("IN", now) }, US: { open: isMarketOpen("US", now) } };
}

const kiteKey = (i: Instrument) => `${i.exchange}:${i.brokerSymbol}`;

/**
 * QuoteFallback for IN instruments Yahoo could not price: Kite LTP keyed "NSE:INFY".
 * Not connected / token expired → empty map without a network call. Never throws.
 */
export const kiteLtp: QuoteFallback = async (list) => {
  const inList = list.filter((i) => i.market === "IN");
  if (!inList.length) return new Map();
  try {
    const c = await getConnection("kite");
    if (c.status !== "connected" || (c.tokenExpiresAt && c.tokenExpiresAt.getTime() <= Date.now())) return new Map();
    const ltp = await withKite((call) => getLtp(call, inList.map(kiteKey)));
    return new Map(inList.flatMap((i): [string, number][] => (ltp[kiteKey(i)] > 0 ? [[i.id, ltp[kiteKey(i)]]] : [])));
  } catch (e) {
    console.error("[live] kite ltp fallback failed:", e instanceof Error ? e.message : e);
    return new Map();
  }
};

/** Cross-instance guard: one refresh of the same instrument set per this window. */
export const GUARD_MS = 15_000;

export type FreshStatus = "closed" | "fresh" | "recent" | "refreshed" | "pending";

// Per-process dedupe: concurrent renders asking for the same set share one refresh.
const inflight = new Map<string, Promise<FreshStatus>>();

/**
 * Atomic claim on a settings row keyed by the set: succeeds only if no refresh of this set
 * started in the last GUARD_MS (DB clock), so parallel serverless instances don't stampede Yahoo.
 * ponytail: one settings row per distinct set (a few: holdings, watchlist); prune if sets churn.
 */
async function claim(key: string): Promise<boolean> {
  const rows = await db
    .insert(settings)
    .values({ key, value: {} })
    .onConflictDoUpdate({
      target: settings.key,
      set: { updatedAt: sql`now()` },
      setWhere: sql`${settings.updatedAt} < now() - make_interval(secs => ${GUARD_MS / 1000})`,
    })
    .returning({ key: settings.key });
  return rows.length > 0;
}

async function refreshStale(open: Instrument[], key: string, maxAgeMs: number, now: Date): Promise<FreshStatus> {
  const latest = await db
    .select({ id: priceLatest.instrumentId, asOf: priceLatest.asOf })
    .from(priceLatest)
    .where(
      inArray(
        priceLatest.instrumentId,
        open.map((i) => i.id),
      ),
    );
  const asOf = new Map(latest.map((r) => [r.id, r.asOf.getTime()]));
  const stale = open.filter((i) => (asOf.get(i.id) ?? 0) < now.getTime() - maxAgeMs);
  if (!stale.length) return "fresh";
  if (!(await claim(key))) return "recent";
  await refreshLatest(stale, { fallback: kiteLtp });
  return "refreshed";
}

/**
 * Refresh price_latest for `list` instruments whose market is open and whose price is older
 * than maxAgeMs (or missing). Waits at most budgetMs; past that it returns "pending" and the
 * refresh finishes in after() (the next render shows it). Throws only on DB errors inside the
 * budget: callers on a page catch and log.
 */
export async function ensureFresh(
  list: Instrument[],
  { maxAgeMs = 60_000, budgetMs = 4_000, now = new Date() }: { maxAgeMs?: number; budgetMs?: number; now?: Date } = {},
): Promise<FreshStatus> {
  // price_unavailable = definitive Yahoo 404: retrying per render only burns the budget.
  const open = list.filter((i) => !i.priceUnavailable && isMarketOpen(i.market, now));
  if (!open.length) return "closed";
  const key = `live_prices:${createHash("sha1")
    .update(open.map((i) => i.id).sort().join(","))
    .digest("hex")
    .slice(0, 16)}`;

  let work = inflight.get(key);
  if (!work) {
    work = refreshStale(open, key, maxAgeMs, now).finally(() => inflight.delete(key));
    inflight.set(key, work);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"pending">((r) => (timer = setTimeout(() => r("pending"), budgetMs)));
  const status = await Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  if (status === "pending") {
    const rest = work.catch((e) => console.error("[live] background price refresh failed", e));
    try {
      after(rest); // keep the serverless function alive until the refresh lands
    } catch {
      // Outside a request scope (scripts, tests): the promise simply runs on.
    }
  }
  return status;
}
