"use server";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { holdingSnapshots, instruments } from "@/db/schema";
import { authorize } from "@/lib/auth/access";
import { enrichInstrument } from "@/lib/market/prices";
import { YahooRateLimited } from "@/lib/market/yahoo";
import { latestSnapshotRunIds } from "@/lib/views/holdings";

export type EnrichResult = { enriched: number; failed: number; remaining: number; limited: boolean } | { error: string } | null;

/** Per click: Yahoo's quoteSummary is crumb-gated and rate-limits bursts. */
const ENRICH_BATCH = 8;
const ENRICH_PAUSE_MS = 400;

/** Owner only. Fetch sector/industry/market cap from Yahoo for held instruments without a sector, a few per click. */
export async function enrichMissingAction(): Promise<EnrichResult> {
  await authorize("manage");
  const runIds = await latestSnapshotRunIds();
  if (!runIds.length) return { enriched: 0, failed: 0, remaining: 0, limited: false };
  const missing = await db
    .select()
    .from(instruments)
    .where(
      and(
        isNull(instruments.sector),
        eq(instruments.sectorOverridden, false),
        inArray(
          instruments.id,
          db
            .select({ id: holdingSnapshots.instrumentId })
            .from(holdingSnapshots)
            .where(and(inArray(holdingSnapshots.runId, runIds), sql`${holdingSnapshots.qty} > 0`)),
        ),
      ),
    )
    // Random order: names Yahoo can't classify (ETFs) would otherwise take the same slots every click.
    .orderBy(sql`random()`);

  let enriched = 0;
  let failed = 0;
  let limited = false;
  for (const [n, i] of missing.slice(0, ENRICH_BATCH).entries()) {
    if (n) await new Promise((r) => setTimeout(r, ENRICH_PAUSE_MS));
    try {
      const s = await enrichInstrument(i);
      if (s.sector) enriched++;
      else failed++; // ETFs and funds have no sector
    } catch (e) {
      failed++;
      if (e instanceof YahooRateLimited) {
        limited = true;
        break;
      }
      console.error(`[overview] enrich ${i.brokerSymbol} failed`, e);
    }
  }
  revalidatePath("/");
  return { enriched, failed, remaining: missing.length - enriched, limited };
}
