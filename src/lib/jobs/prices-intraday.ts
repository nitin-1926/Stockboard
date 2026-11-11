import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { holdingSnapshots, instruments, targets, watchItems } from "@/db/schema";
import { replay } from "@/lib/ledger/lots";
import { loadLedger } from "@/lib/ledger/queries";
import { kiteLtp } from "@/lib/market/live";
import { refreshLatest } from "@/lib/market/prices";
import type { Market } from "@/lib/returns/types";
import { latestSnapshotRunIds } from "@/lib/views/holdings";
import type { JobResult } from "./registry";
import { isMarketOpen } from "./schedule";

export const MARKETS: Market[] = ["IN", "US"];

/** Test hook: restrict a job to these instrument ids (the shared dev DB holds real rows). */
export type Scope = { only?: string[] };

/**
 * Instruments a market's price jobs keep fresh: held (latest broker snapshot qty > 0, or an
 * open ledger lot) ∪ active watch items ∪ pending targets ∪ benchmarks.
 */
export async function trackedInstruments(market: Market, { only }: Scope = {}) {
  const runs = await latestSnapshotRunIds();
  const [snap, ledger, watched, targeted] = await Promise.all([
    runs.length
      ? db
          .select({ id: holdingSnapshots.instrumentId })
          .from(holdingSnapshots)
          .where(and(inArray(holdingSnapshots.runId, runs), sql`${holdingSnapshots.qty} > 0`))
      : [],
    loadLedger(db),
    db.select({ id: watchItems.instrumentId }).from(watchItems).where(isNull(watchItems.archivedAt)),
    db.select({ id: targets.instrumentId }).from(targets).where(eq(targets.status, "pending")),
  ]);
  const ids = new Set([...snap, ...watched, ...targeted].map((r) => r.id));
  for (const l of replay(ledger.events, ledger.supersessions).openLots) ids.add(l.instrumentId);
  const rows = await db
    .select()
    .from(instruments)
    .where(
      and(
        eq(instruments.market, market),
        ids.size ? or(eq(instruments.isBenchmark, true), inArray(instruments.id, [...ids])) : eq(instruments.isBenchmark, true),
      ),
    );
  return only ? rows.filter((r) => only.includes(r.id)) : rows;
}

/** Every ~15 min: refresh price_latest for each OPEN market's tracked set (Yahoo spark; Kite LTP fallback for IN). */
export async function pricesIntraday(now = new Date(), scope: Scope = {}): Promise<JobResult> {
  const counts: JobResult["counts"] = {};
  const closed: string[] = [];
  for (const m of MARKETS) {
    if (!isMarketOpen(m, now)) {
      closed.push(`${m} closed`);
      continue;
    }
    const list = await trackedInstruments(m, scope);
    const r = await refreshLatest(list, { fallback: kiteLtp });
    for (const [k, v] of Object.entries(r)) counts[`${m}_${k}`] = v;
  }
  if (closed.length) counts.skipped = closed.join(", ");
  return { counts };
}
