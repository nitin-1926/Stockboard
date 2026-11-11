import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { instruments, ledgerEvents } from "@/db/schema";
import { addDays, ensureFxRange, today } from "@/lib/market/fx";
import { backfillHistory } from "@/lib/market/prices";
import { type Scope, trackedInstruments } from "./prices-intraday";
import type { JobResult } from "./registry";

/** Resume point: instruments are processed in id order; `after` is the last one done. */
export type BackfillCursor = { after: string };

/** History depth for FX when the ledger is younger (benchmarks' alpha needs it). */
const BENCHMARK_YEARS = 5;

/**
 * Manual, chunked, resumable (U17). Every tracked instrument (both markets, benchmarks
 * included) plus anything with ledger events (sold positions still need history for U18)
 * gets full daily history, raw, with dividends and corporate actions. range=max rather than
 * "from the first ledger date": it covers that, and U8 would refetch max anyway the moment a
 * partial fetch found a dividend not yet stored, which a first backfill always does.
 * The first chunk also fills fx_daily from the earliest ledger date (or 5 years back).
 * ponytail: fixed chunk of 10 instruments (~5 s each); add a time budget if chunks near 300 s.
 */
export async function runBackfill(
  cursor: BackfillCursor | null,
  { only, chunkSize = 10 }: Scope & { chunkSize?: number } = {},
): Promise<JobResult> {
  const ledgerIds = (await db.selectDistinct({ id: ledgerEvents.instrumentId }).from(ledgerEvents)).map((r) => r.id);
  const [inTracked, usTracked, inLedger] = await Promise.all([
    trackedInstruments("IN", { only }),
    trackedInstruments("US", { only }),
    ledgerIds.length ? db.select().from(instruments).where(inArray(instruments.id, ledgerIds)) : [],
  ]);
  const all = new Map(
    [...inTracked, ...usTracked, ...inLedger.filter((i) => !only || only.includes(i.id))].map((i) => [i.id, i]),
  );
  const todo = [...all.values()].sort((a, b) => a.id.localeCompare(b.id)).filter((i) => !cursor || i.id > cursor.after);

  let fx = 0;
  if (!cursor) {
    const scoped = only ? ledgerIds.filter((id) => only.includes(id)) : ledgerIds;
    const [{ first }] = scoped.length
      ? await db
          .select({ first: sql<string | null>`min(${ledgerEvents.date})::text` })
          .from(ledgerEvents)
          .where(inArray(ledgerEvents.instrumentId, scoped))
      : [{ first: null }];
    const floor = addDays(today(), -365 * BENCHMARK_YEARS);
    fx = await ensureFxRange(first && first < floor ? first : floor, today());
  }

  const batch = todo.slice(0, chunkSize);
  let bars = 0;
  let newEvents = 0;
  // A throw here fails the run; the handler keeps the last completed cursor, so the chunk is retried.
  for (const i of batch) {
    const r = await backfillHistory(i, { range: "max" });
    bars += r.bars;
    newEvents += r.newEvents;
  }
  const done = todo.length <= chunkSize;
  return {
    counts: { instruments: batch.length, remaining: todo.length - batch.length, bars, newEvents, fx },
    done,
    cursor: done ? undefined : { after: batch[batch.length - 1].id },
  };
}
