import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The one bordered surface. Use only for a self-contained unit (KPI group, chart, table). */
export function Panel({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("min-w-0 rounded-lg border bg-card", className)} {...props} />;
}

export function PanelHeader({ title, id, children, className }: { title: ReactNode; id?: string; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-12 items-center justify-between gap-3 border-b px-4 py-2.5", className)}>
      <h2 id={id} className="text-sm font-semibold">
        {title}
      </h2>
      {children && <div className="flex items-center gap-2 text-xs text-muted-foreground">{children}</div>}
    </div>
  );
}

/** Label above value. `align="end"` for numeric columns. */
export function Stat({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="num text-[15px] font-semibold">{children}</dd>
    </div>
  );
}

/** Mono ticker with the company name below (omitted when it just repeats the symbol). */
export function Ticker({ symbol, name, className }: { symbol: string; name?: string | null; className?: string }) {
  const showName = name && name.trim().toUpperCase() !== symbol.toUpperCase();
  return (
    <span className={cn("flex min-w-0 flex-col", className)}>
      <span className="text-[13px] font-semibold tracking-[0.01em]">{symbol}</span>
      {showName && <span className="truncate text-xs text-muted-foreground">{name}</span>}
    </span>
  );
}

const TAG = {
  neutral: "border-border text-muted-foreground",
  buy: "border-gain/25 bg-gain/10 text-gain",
  sell: "border-loss/25 bg-loss/10 text-loss",
  brand: "border-brand/30 bg-brand/10 text-foreground",
} as const;

export function Tag({ tone = "neutral", className, ...props }: ComponentProps<"span"> & { tone?: keyof typeof TAG }) {
  return (
    <span
      className={cn("inline-flex h-5 items-center rounded-sm border px-1.5 text-[11px] font-medium whitespace-nowrap", TAG[tone], className)}
      {...props}
    />
  );
}
