// Pure manager scorecard (U16): per set_by, targets and stops scored separately.
import type { ISODate } from "@/lib/returns/types";
import { daysToResolve, type TargetKind, type TargetStatus } from "./evaluate";

export interface ScoreInput {
  setBy: string;
  kind: TargetKind;
  status: TargetStatus;
  setOn: ISODate;
  resolvedAt: ISODate | null;
  missPct: number | null;
}

export interface KindScore {
  /** Everything except cancelled (an edit cancels the old row; withdrawn calls aren't scored). */
  total: number;
  /** hit / stopped / expired. */
  resolved: number;
  /** Reached (hit for a target, stopped for a stop). */
  reached: number;
  /** reached / resolved; null with nothing resolved. */
  hitRate: number | null;
  medianDaysToHit: number | null;
  /** Mean miss_pct over expired ones. */
  avgMissPct: number | null;
  open: number;
  cancelled: number;
}

export interface Scorecard {
  setBy: string;
  target: KindScore;
  stop: KindScore;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function score(rows: ScoreInput[]): KindScore {
  const reachedRows = rows.filter((r) => r.status === "hit" || r.status === "stopped");
  const expired = rows.filter((r) => r.status === "expired");
  const misses = expired.map((r) => r.missPct).filter((m): m is number => m != null);
  const resolved = reachedRows.length + expired.length;
  return {
    total: rows.filter((r) => r.status !== "cancelled").length,
    resolved,
    reached: reachedRows.length,
    hitRate: resolved ? reachedRows.length / resolved : null,
    medianDaysToHit: median(reachedRows.map((r) => daysToResolve(r.setOn, r.resolvedAt)!)),
    avgMissPct: misses.length ? misses.reduce((s, m) => s + m, 0) / misses.length : null,
    open: rows.filter((r) => r.status === "pending").length,
    cancelled: rows.filter((r) => r.status === "cancelled").length,
  };
}

/** One card per set_by, most targets first. */
export function scorecards(rows: ScoreInput[]): Scorecard[] {
  const by = Map.groupBy(rows, (r) => r.setBy);
  return [...by]
    .map(([setBy, rs]) => ({
      setBy,
      target: score(rs.filter((r) => r.kind === "target")),
      stop: score(rs.filter((r) => r.kind === "stop")),
    }))
    .sort((a, b) => b.target.total + b.stop.total - (a.target.total + a.stop.total) || a.setBy.localeCompare(b.setBy));
}
