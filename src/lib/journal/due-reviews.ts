import { and, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { instruments, journalEntries, targets } from "@/db/schema";
import { can, requireActor } from "@/lib/auth/access";
import { isoInMarket } from "@/lib/ledger/queries";
import { daysBetween } from "@/lib/returns/xirr";
import type { Currency, ISODate } from "@/lib/returns/types";
import type { TargetKind, TargetStatus } from "@/lib/targets/evaluate";
import type { JournalKind, JournalSubject } from "./kinds";

// "Due for review" (U20): a target that resolved (hit, stopped, expired) or whose deadline
// passed within the last REVIEW_WINDOW_DAYS, that somebody wrote a thesis for, and that has
// no review entry on it since it resolved. Pure core + a loader, like the view modules.

export const REVIEW_WINDOW_DAYS = 7;

export interface DueTarget {
  id: string;
  instrumentId: string;
  symbol: string;
  currency: Currency;
  kind: TargetKind;
  price: number;
  status: TargetStatus;
  deadline: ISODate | null;
  resolvedAt: ISODate | null;
  missPct: number | null;
}

export interface DueEntry {
  subjectType: JournalSubject;
  subjectId: string;
  instrumentId: string;
  kind: JournalKind;
  createdAt: Date;
}

export interface DueReview {
  targetId: string;
  instrumentId: string;
  symbol: string;
  currency: Currency;
  kind: TargetKind;
  /** The level as stored (on the set date's basis). */
  price: number;
  /** A pending target past its deadline reads as expired (the nightly job expires it on its next run). */
  outcome: "hit" | "stopped" | "expired";
  /** Expired: (best − level) / level; null for hit/stopped or before the job has scored it. */
  missPct: number | null;
  resolvedOn: ISODate;
  daysSince: number;
}

/** The day the target resolved: resolved_at, or the passed deadline of a still-pending one. */
function resolution(t: DueTarget, today: ISODate): { on: ISODate; outcome: DueReview["outcome"] } | null {
  if (t.status === "hit" || t.status === "stopped" || t.status === "expired") return t.resolvedAt ? { on: t.resolvedAt, outcome: t.status } : null;
  if (t.status === "pending" && t.deadline && t.deadline < today) return { on: t.deadline, outcome: "expired" };
  return null;
}

/** Pure. Newest resolution first. */
export function dueReviews(targetsIn: DueTarget[], entries: DueEntry[], now: Date): DueReview[] {
  const out: DueReview[] = [];
  for (const t of targetsIn) {
    const today = isoInMarket(now, t.currency).slice(0, 10);
    const r = resolution(t, today);
    if (!r) continue;
    const daysSince = daysBetween(r.on, today);
    if (daysSince < 0 || daysSince > REVIEW_WINDOW_DAYS) continue;
    const thesis = entries.some(
      (e) =>
        e.kind === "thesis" &&
        ((e.subjectType === "target" && e.subjectId === t.id) || (e.subjectType !== "target" && e.instrumentId === t.instrumentId)),
    );
    if (!thesis) continue;
    const reviewed = entries.some(
      (e) => e.kind === "review" && e.subjectType === "target" && e.subjectId === t.id && isoInMarket(e.createdAt, t.currency).slice(0, 10) >= r.on,
    );
    if (reviewed) continue;
    out.push({
      targetId: t.id,
      instrumentId: t.instrumentId,
      symbol: t.symbol,
      currency: t.currency,
      kind: t.kind,
      price: t.price,
      outcome: r.outcome,
      missPct: r.outcome === "expired" ? t.missPct : null,
      resolvedOn: r.on,
      daysSince,
    });
  }
  return out.sort((a, b) => b.resolvedOn.localeCompare(a.resolvedOn) || a.symbol.localeCompare(b.symbol));
}

/** Loader. Viewers can't write a review, so they get nothing. */
export async function getDueReviews(): Promise<DueReview[]> {
  const actor = await requireActor(); // before new Date(): it opts the render out of prerendering
  if (!can(actor, "suggest")) return [];
  const now = new Date();
  // A day of slack around the window: the exact cut is made per market zone in dueReviews().
  const since = new Date(now.getTime() - (REVIEW_WINDOW_DAYS + 2) * 86_400_000).toISOString().slice(0, 10);
  const rows = await db
    .select({ t: targets, symbol: instruments.brokerSymbol, currency: instruments.currency })
    .from(targets)
    .innerJoin(instruments, eq(instruments.id, targets.instrumentId))
    .where(and(ne(targets.status, "cancelled"), gte(sql`coalesce(${targets.resolvedAt}, ${targets.deadline})`, since)));
  if (!rows.length) return [];
  const entries = await db
    .select({
      subjectType: journalEntries.subjectType,
      subjectId: journalEntries.subjectId,
      instrumentId: journalEntries.instrumentId,
      kind: journalEntries.kind,
      createdAt: journalEntries.createdAt,
    })
    .from(journalEntries)
    .where(and(isNull(journalEntries.deletedAt), inArray(journalEntries.instrumentId, [...new Set(rows.map((r) => r.t.instrumentId))])));
  return dueReviews(
    rows.map(({ t, symbol, currency }) => ({
      id: t.id,
      instrumentId: t.instrumentId,
      symbol,
      currency,
      kind: t.kind,
      price: Number(t.price),
      status: t.status,
      deadline: t.deadline,
      resolvedAt: t.resolvedAt,
      missPct: t.missPct == null ? null : Number(t.missPct),
    })),
    entries,
    now,
  );
}
