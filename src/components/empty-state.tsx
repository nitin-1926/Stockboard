import { ConstructionIcon, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-start gap-4 rounded-lg border border-dashed px-6 py-10 sm:px-8", className)}>
      <Icon className="size-5 text-faint" strokeWidth={1.75} aria-hidden />
      <div className="flex max-w-prose flex-col gap-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        {children && <div className="text-[13px] text-muted-foreground">{children}</div>}
      </div>
      {action}
    </div>
  );
}

/** Placeholder page for a route whose unit hasn't landed yet (keeps the nav from 404ing). */
export function ComingSoon({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <EmptyState icon={ConstructionIcon} title="Coming in a later step">
        {children}
      </EmptyState>
    </div>
  );
}
