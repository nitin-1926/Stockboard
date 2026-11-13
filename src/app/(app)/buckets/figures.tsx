import { Dash, Delta } from "@/components/money";
import type { Alpha, BucketCard } from "@/lib/views/buckets";

// Shared bucket figures (list and detail). Server-safe, no hooks.

/** The bucket's headline return: real money when it has any, else paper (equal-weighted). */
export function headline(b: Pick<BucketCard, "real" | "paper">) {
  return b.real.count > 0
    ? { returnPct: b.real.returnPct, xirr: b.real.xirr, useAbsolute: b.real.useAbsolute }
    : { returnPct: b.paper.returnPct, xirr: b.paper.annualizedPct, useAbsolute: b.paper.useAbsolute };
}

/** XIRR from a year on; before that annualizing misleads, so it stays blank. */
export function XirrFigure({ xirr, useAbsolute }: { xirr: number | null; useAbsolute: boolean }) {
  return useAbsolute ? <Dash label="Under a year" /> : <Delta value={xirr} />;
}

export function AlphaFigure({ a }: { a: Alpha }) {
  if (a.status === "pending") return <span className="text-xs text-faint" title={`${a.label} history not stored yet`}>Pending</span>;
  if (a.status !== "ok") return <Dash label="Not enough data" />;
  return (
    <span title={`vs ${a.label}, ${a.annualized ? "a year" : "total"}`}>
      <Delta value={a.alpha} />
    </span>
  );
}
