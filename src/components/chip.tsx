import Link from "next/link";
import type { ReactNode } from "react";
import type { BucketColor } from "@/db/schema/buckets";
import { cn } from "@/lib/utils";

/** URL-state filter chip (a link, no client JS). Watchlist tags, holdings buckets. */
export function Chip({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? "true" : undefined}
      className={cn(
        "inline-flex min-h-10 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors md:min-h-7",
        active ? "border-brand/40 bg-brand/10 text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </Link>
  );
}

/** A bucket's identity color (theme chart token), next to its name. Decorative: the name carries meaning. */
export function BucketSwatch({ color, className }: { color: BucketColor; className?: string }) {
  return <span aria-hidden className={cn("size-2.5 shrink-0 rounded-[3px]", className)} style={{ background: `var(--${color})` }} />;
}

/** Bucket name as a small link chip (holdings / watchlist rows). */
export function BucketTag({ id, name, color }: { id: string; name: string; color: BucketColor }) {
  return (
    <Link
      href={`/buckets/${id}`}
      className="inline-flex h-5 max-w-40 items-center gap-1.5 rounded-sm border px-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
    >
      <BucketSwatch color={color} className="size-2" />
      <span className="truncate">{name}</span>
    </Link>
  );
}
