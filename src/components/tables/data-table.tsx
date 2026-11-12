// Server-rendered sortable table. Sort state lives in the URL: headers are links, so
// sorting is shareable, survives reload/back, and needs no client JS. The caller sorts
// the rows; this component only renders headers, aria-sort and the mobile card list.
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type SortDir = "asc" | "desc";

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  align?: "left" | "right";
  sortable?: boolean;
  /** Direction on first click. Numbers default to desc (biggest first). */
  firstDir?: SortDir;
  /** Also offer this sort in the mobile sort bar. */
  mobileSort?: boolean;
  className?: string;
}

export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  sort,
  hrefFor,
  mobileRow,
  footer,
}: {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  sort: { key: string; dir: SortDir };
  hrefFor: (key: string, dir: SortDir) => string;
  /** Card rendering below md; the table renders from md up. */
  mobileRow: (row: T) => ReactNode;
  footer?: ReactNode;
}) {
  const next = (c: Column<T>): SortDir =>
    sort.key === c.key ? (sort.dir === "asc" ? "desc" : "asc") : (c.firstDir ?? "desc");
  const mobileSorts = columns.filter((c) => c.sortable && c.mobileSort);

  return (
    <div className="flex flex-col gap-3">
      {mobileSorts.length > 0 && (
        <nav aria-label={`Sort ${caption.toLowerCase()}`} className="flex flex-wrap items-center gap-1.5 md:hidden">
          <span className="mr-1 text-xs text-muted-foreground">Sort</span>
          {mobileSorts.map((c) => {
            const active = sort.key === c.key;
            return (
              <Link
                key={c.key}
                href={hrefFor(c.key, next(c))}
                scroll={false}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "inline-flex min-h-10 items-center gap-1 rounded-md border px-2.5 text-xs font-medium transition-colors",
                  active ? "border-brand/40 bg-brand/10 text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {c.header}
                {active && <SortGlyph dir={sort.dir} />}
              </Link>
            );
          })}
        </nav>
      )}

      <ul className="flex flex-col divide-y rounded-lg border bg-card md:hidden" aria-label={caption}>
        {rows.map((r) => (
          <li key={rowKey(r)}>{mobileRow(r)}</li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto rounded-lg border bg-card md:block">
        <table className="w-full text-[13px]">
          <caption className="sr-only">{caption}</caption>
          <thead className="border-b">
            <tr>
              {columns.map((c) => {
                const active = sort.key === c.key;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={c.sortable ? (active ? (sort.dir === "asc" ? "ascending" : "descending") : "none") : undefined}
                    className={cn(
                      "group/th h-10 px-3 text-xs font-medium whitespace-nowrap text-muted-foreground first:pl-4 last:pr-4",
                      c.align === "right" ? "text-right" : "text-left",
                      c.className,
                    )}
                  >
                    {c.sortable ? (
                      <Link
                        href={hrefFor(c.key, next(c))}
                        scroll={false}
                        className={cn(
                          "-mx-1.5 inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                          c.align === "right" && "flex-row-reverse",
                          active && "text-foreground",
                        )}
                      >
                        {c.header}
                        {active ? (
                          <SortGlyph dir={sort.dir} />
                        ) : (
                          <ChevronsUpDownIcon className="size-3 opacity-0 transition-opacity group-hover/th:opacity-40" aria-hidden />
                        )}
                      </Link>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => (
              <tr key={rowKey(r)} className="transition-colors hover:bg-muted/60">
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      "h-13 px-3 py-2 align-middle first:pl-4 last:pr-4",
                      c.align === "right" && "num text-right whitespace-nowrap",
                      c.className,
                    )}
                  >
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer}
    </div>
  );
}

function SortGlyph({ dir }: { dir: SortDir }) {
  const Icon = dir === "asc" ? ArrowUpIcon : ArrowDownIcon;
  return (
    <>
      <Icon className="size-3" aria-hidden />
      <span className="sr-only">{dir === "asc" ? "(ascending)" : "(descending)"}</span>
    </>
  );
}
