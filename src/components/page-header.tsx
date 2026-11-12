import type { ReactNode } from "react";

/** Page title + one optional faint meta line + right-aligned actions. Nothing else (docs/design/SYSTEM.md). */
export function PageHeader({ title, meta, actions }: { title: string; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-[-0.015em]">{title}</h1>
        {meta && <p className="text-xs text-faint">{meta}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
