import Link from "next/link";
import { cn } from "@/lib/utils";

/** URL-state toggle group (links, no client JS). Shared by holdings and watchlist. */
export function Segmented({ label, options }: { label: string; options: { label: string; href: string; active: boolean }[] }) {
  return (
    <nav aria-label={label} className="inline-flex rounded-md bg-muted p-0.5">
      {options.map((o) => (
        <Link
          key={o.label}
          href={o.href}
          scroll={false}
          aria-current={o.active ? "page" : undefined}
          className={cn(
            "inline-flex min-h-10 items-center rounded-[5px] px-3 text-[13px] font-medium tabular-nums transition-colors md:min-h-7",
            o.active ? "bg-card text-foreground shadow-xs ring-1 ring-border" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </Link>
      ))}
    </nav>
  );
}
