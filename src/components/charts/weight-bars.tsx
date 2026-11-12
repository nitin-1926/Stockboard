// Share-of-portfolio bars. Plain server-rendered HTML: every value is printed next to its
// bar, so the text IS the accessible summary and the bars are decorative (aria-hidden).
import Link from "next/link";
import { formatPercent } from "@/components/money";
import { cn } from "@/lib/utils";

export type BarRow = { key: string; label: string; weightPct: number; href?: string; muted?: boolean };

/** Label left, thin bar, % right. Rows above `limit` turn loss-colored and say so to screen readers. */
export function WeightBars({ rows, limit, label }: { rows: BarRow[]; limit?: number; label: string }) {
  // Muted rows (a combined "others" remainder) get no bar, so they never set the scale.
  const scale = Math.max(...rows.filter((r) => !r.muted).map((r) => r.weightPct)) || 1;
  return (
    <ul aria-label={label} className="flex flex-col">
      {rows.map((r) => {
        const over = limit != null && !r.muted && r.weightPct > limit;
        return (
          <li key={r.key} className="grid h-8 grid-cols-[7rem_minmax(0,1fr)_3.5rem] items-center gap-3 text-[13px] sm:grid-cols-[9rem_minmax(0,1fr)_3.5rem]">
            {r.href ? (
              <Link href={r.href} className="truncate font-semibold tracking-[0.01em] hover:underline hover:underline-offset-4" title={r.label}>
                {r.label}
              </Link>
            ) : (
              <span className={cn("truncate", r.muted && "text-muted-foreground")} title={r.label}>
                {r.label}
              </span>
            )}
            <span aria-hidden className="flex h-1.5 items-center">
              {!r.muted && (
                <span className={cn("h-full min-w-0.5 rounded-[2px]", over ? "bg-loss" : "bg-muted-foreground/70")} style={{ width: `${(r.weightPct / scale) * 100}%` }} />
              )}
            </span>
            <span className={cn("num text-right", over ? "font-medium text-loss" : "text-muted-foreground")}>
              {formatPercent(r.weightPct, 1)}
              {over && <span className="sr-only">, above the {formatPercent(limit!, 0)} limit</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
