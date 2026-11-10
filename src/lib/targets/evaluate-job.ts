import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "@/db";
import { corporateActions, instruments, pricesDaily, targets } from "@/db/schema";
import { isoInMarket } from "@/lib/ledger/queries";
import type { Market } from "@/lib/returns/types";
import { type Evaluation, evaluate, type TargetStatus } from "./evaluate";

// Evaluates every pending target against stored raw bars (prices_daily) and corporate
// actions, and writes the changes in ONE transaction. U17's EOD job calls it after it has
// written the day's bars; the owner's "Re-evaluate now" calls it too. Idempotent: running
// it twice for the same asOf changes nothing the second time.

const str = (n: number | null) => (n == null ? null : String(Number(n.toFixed(6))));
const num = (s: string | null) => (s == null ? null : Number(s));

export type EvaluateResult = { checked: number; resolved: Record<Exclude<TargetStatus, "pending" | "cancelled">, number>; updated: number };

/**
 * `asOf` is a moment: each target is judged as of its own market's local date then
 * (an IST evening is still the previous day in New York). `market` limits the run to
 * one market, for a per-market EOD.
 */
export async function evaluatePendingTargets(asOf: Date = new Date(), market?: Market): Promise<EvaluateResult> {
  return db.transaction(async (tx) => {
    const pending = await tx
      .select({ t: targets, currency: instruments.currency })
      .from(targets)
      .innerJoin(instruments, eq(instruments.id, targets.instrumentId))
      .where(and(eq(targets.status, "pending"), market ? eq(instruments.market, market) : undefined))
      .for("update", { of: targets });
    const result: EvaluateResult = { checked: pending.length, resolved: { hit: 0, stopped: 0, expired: 0 }, updated: 0 };
    if (!pending.length) return result;

    const ids = [...new Set(pending.map((p) => p.t.instrumentId))];
    const setOn = (p: (typeof pending)[number]) => isoInMarket(p.t.setAt, p.currency).slice(0, 10);
    const earliest = pending.map(setOn).sort()[0];
    const [bars, acts] = await Promise.all([
      tx
        .select()
        .from(pricesDaily)
        .where(and(inArray(pricesDaily.instrumentId, ids), gt(pricesDaily.date, earliest))),
      tx.select().from(corporateActions).where(and(inArray(corporateActions.instrumentId, ids), gt(corporateActions.exDate, earliest))),
    ]);

    for (const p of pending) {
      const t = p.t;
      const before: Evaluation = {
        status: t.status,
        resolvedAt: t.resolvedAt,
        resolvedPrice: num(t.resolvedPrice),
        bestPrice: num(t.bestPrice),
        missPct: num(t.missPct),
      };
      const next = evaluate(
        { kind: t.kind, price: Number(t.price), setOn: setOn(p), deadline: t.deadline, status: t.status },
        bars
          .filter((b) => b.instrumentId === t.instrumentId)
          .map((b) => ({ date: b.date, high: num(b.high), low: num(b.low), close: Number(b.close) })),
        acts
          .filter((a) => a.instrumentId === t.instrumentId)
          .map((a) => ({ exDate: a.exDate, ratio: Number(a.numerator) / Number(a.denominator) })),
        isoInMarket(asOf, p.currency).slice(0, 10),
      );
      if (next.status !== "pending") result.resolved[next.status as keyof EvaluateResult["resolved"]]++;
      const same = (Object.keys(before) as (keyof Evaluation)[]).every((k) =>
        typeof before[k] === "number" ? str(before[k] as number) === str(next[k] as number) : before[k] === next[k],
      );
      if (same) continue;
      await tx
        .update(targets)
        .set({
          status: next.status,
          resolvedAt: next.resolvedAt,
          resolvedPrice: str(next.resolvedPrice),
          bestPrice: str(next.bestPrice),
          missPct: str(next.missPct),
        })
        .where(and(eq(targets.id, t.id), eq(targets.status, "pending")));
      result.updated++;
    }
    return result;
  });
}
