import { LockIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function OwnerOnly() {
  return (
    <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <LockIcon className="size-4 text-faint" aria-hidden />
      Only the owner can view or change these settings.
    </p>
  );
}

/** Settings panel header: title, optional one-line description, controls on the right (wraps on mobile). */
export function SectionHeader({ title, description, id, className, children }: { title: string; description?: ReactNode; id?: string; className?: string; children?: ReactNode }) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b px-4 py-3", className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 id={id} className="text-sm font-semibold">
          {title}
        </h2>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2 max-sm:has-[form]:w-full">{children}</div>}
    </div>
  );
}

/** Label above value, for the small fact grids in settings panels. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="num text-[13px]">{children}</dd>
    </div>
  );
}

export const Faint = ({ children = "-" }: { children?: ReactNode }) => <span className="text-faint">{children}</span>;

export const fmtDate = (d: Date | null, empty = "Never") =>
  d ? d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : empty;
