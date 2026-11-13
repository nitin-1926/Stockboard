import { NotebookPenIcon, PlusIcon, TargetIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { EmptyState } from "@/components/empty-state";
import { Dash, Delta, formatDate, formatPercent, Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Panel, Stat, Tag, Ticker } from "@/components/panel";
import { Segmented } from "@/components/segmented";
import { type Column, DataTable, type SortDir } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getDueReviews } from "@/lib/journal/due-reviews";
import { getTargetsView, type ScorecardRow, type TargetRow } from "@/lib/views/targets";
import { ReevaluateButton, TargetEditor, TargetRowActions } from "./editor";

// Filter and sort live in the URL (?show=hit|missed|all&sort=<key>&dir=asc|desc): shareable,
// survives reload. Defaults are omitted.
type Show = "pending" | "hit" | "missed" | "all";
type State = { show: Show; sort: string; dir: SortDir };
const DEFAULT_SORT: Record<Show, { sort: string; dir: SortDir }> = {
  pending: { sort: "distance", dir: "asc" },
  hit: { sort: "resolved", dir: "desc" },
  missed: { sort: "resolved", dir: "desc" },
  all: { sort: "set", dir: "desc" },
};
const SHOWS: { key: Show; label: string; match: (r: TargetRow) => boolean }[] = [
  { key: "pending", label: "Pending", match: (r) => r.status === "pending" },
  { key: "hit", label: "Hit", match: (r) => r.status === "hit" || r.status === "stopped" },
  { key: "missed", label: "Missed", match: (r) => r.status === "expired" },
  { key: "all", label: "All", match: () => true },
];

const SORTS: Record<string, (r: TargetRow) => number | string | null> = {
  symbol: (r) => r.symbol,
  distance: (r) => (r.distancePct == null ? null : Math.abs(r.distancePct)),
  deadline: (r) => r.deadline,
  resolved: (r) => r.resolvedAt,
  set: (r) => r.setOn,
};

function parse(sp: Record<string, string | string[] | undefined>): State {
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const show = SHOWS.find((x) => x.key === one("show"))?.key ?? "pending";
  const sort = one("sort");
  const d = DEFAULT_SORT[show];
  return {
    show,
    sort: sort && sort in SORTS ? sort : d.sort,
    dir: one("dir") === "asc" ? "asc" : one("dir") === "desc" ? "desc" : d.dir,
  };
}

function href(s: State) {
  const q = new URLSearchParams();
  if (s.show !== "pending") q.set("show", s.show);
  const d = DEFAULT_SORT[s.show];
  if (s.sort !== d.sort) q.set("sort", s.sort);
  if (s.dir !== d.dir) q.set("dir", s.dir);
  const qs = q.toString();
  return qs ? `/targets?${qs}` : "/targets";
}

export default function TargetsPage({ searchParams }: PageProps<"/targets">) {
  return (
    <Suspense fallback={<TargetsSkeleton />}>
      <Targets searchParams={searchParams} />
    </Suspense>
  );
}

const instrumentOf = (r: TargetRow) => ({ id: r.instrumentId, symbol: r.symbol, name: r.name, exchange: r.exchange, currency: r.currency, price: r.ltp });
const editableOf = (r: TargetRow) => ({
  id: r.id,
  kind: r.kind,
  price: r.price,
  inputMode: r.inputMode,
  pctValue: r.pctValue,
  deadline: r.deadline,
  note: r.note,
});

function sorted(rows: TargetRow[], s: State) {
  const key = SORTS[s.sort];
  return [...rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1; // missing last
    const c = typeof x === "string" ? x.localeCompare(y as string) : x - (y as number);
    return s.dir === "asc" ? c : -c;
  });
}

async function Targets({ searchParams }: { searchParams: PageProps<"/targets">["searchParams"] }) {
  const [view, sp, due] = await Promise.all([getTargetsView(), searchParams, getDueReviews()]);
  const dueIds = new Set(due.map((d) => d.targetId));
  const s = parse(sp);
  const all = [...view.active, ...view.history];
  const show = SHOWS.find((x) => x.key === s.show)!;
  const rows = sorted(all.filter(show.match), s);

  const columns: Column<TargetRow>[] = [
    { key: "symbol", header: "Instrument", sortable: true, firstDir: "asc", mobileSort: true, cell: (r) => <Instrument r={r} /> },
    { key: "kind", header: "Kind", cell: (r) => <Tag>{r.kind === "target" ? "Target" : "Stop"}</Tag> },
    { key: "price", header: "Price", align: "right", cell: (r) => <Money value={r.price} currency={r.currency} decimals={2} className="font-medium" /> },
    ...(s.show === "hit"
      ? []
      : [
          {
            key: "distance",
            header: s.show === "missed" ? "Missed by" : "From LTP",
            align: "right",
            sortable: s.show === "pending",
            firstDir: "asc",
            mobileSort: s.show === "pending",
            cell: (r) => (s.show === "all" && r.status !== "pending" ? <Dash /> : <Distance r={r} />),
          } satisfies Column<TargetRow>,
        ]),
    { key: "deadline", header: "Deadline", sortable: true, firstDir: "asc", mobileSort: true, cell: (r) => <Deadline r={r} /> },
    {
      key: "set",
      header: "Set by",
      sortable: true,
      cell: (r) => (
        <span className="block max-w-44 truncate text-faint" title={`${r.setBy}, ${formatDate(r.setOn)}`}>
          {r.setBy}
        </span>
      ),
    },
    ...(s.show === "pending" ? [] : [{ key: "status", header: "Status", cell: (r) => <Status r={r} /> } satisfies Column<TargetRow>]),
    { key: "actions", header: "", className: "w-20", cell: (r) => <Actions r={r} due={dueIds.has(r.id)} /> },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Targets"
        actions={
          <>
            {view.canReevaluate && <ReevaluateButton />}
            {view.canCreate && view.instruments.length > 0 && (
              <TargetEditor instruments={view.instruments}>
                <Button className="h-10 md:h-8">
                  <PlusIcon aria-hidden />
                  New target
                </Button>
              </TargetEditor>
            )}
          </>
        }
      />

      {view.scorecard.length > 0 && <Scorecard rows={view.scorecard} />}

      {all.length === 0 ? (
        <EmptyState icon={TargetIcon} title="No targets yet" className="flex-row items-center gap-3 py-6" />
      ) : (
        <div className="flex flex-col gap-3">
          <div>
            <Segmented
              label="Show"
              options={SHOWS.map((x) => ({
                label: `${x.label} ${all.filter(x.match).length}`,
                href: href({ show: x.key, ...DEFAULT_SORT[x.key] }),
                active: x.key === s.show,
              }))}
            />
          </div>
          {rows.length === 0 ? (
            <EmptyState icon={TargetIcon} title={s.show === "pending" ? "No pending targets" : "Nothing here"} className="flex-row items-center gap-3 py-6" />
          ) : (
            <DataTable
              caption="Targets"
              columns={columns}
              rows={rows}
              rowKey={(r) => r.id}
              sort={{ key: s.sort, dir: s.dir }}
              hrefFor={(k, d) => href({ ...s, sort: k, dir: d })}
              mobileRow={(r) => <MobileRow r={r} due={dueIds.has(r.id)} />}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Instrument({ r }: { r: TargetRow }) {
  return (
    <Link href={`/symbol/${r.instrumentId}`} className="block w-fit max-w-64 underline-offset-4 hover:[&>span>span:first-child]:underline">
      <Ticker symbol={r.symbol} name={r.name} />
    </Link>
  );
}

/** Pending: how far the price must move to reach the level. Expired: how far it fell short. */
function Distance({ r, mobile = false }: { r: TargetRow; mobile?: boolean }) {
  if (r.status === "pending") return <Delta value={r.distancePct} decimals={1} />;
  if (r.status === "expired" && r.missPct != null)
    return <span className="num text-muted-foreground">{`${mobile ? "missed by " : ""}${formatPercent(Math.abs(r.missPct), 1)}`}</span>;
  return mobile ? null : <Dash />;
}

function Deadline({ r }: { r: TargetRow }) {
  if (!r.deadline) return <Dash label="No deadline" />;
  const soon = r.status === "pending" && r.daysLeft != null && r.daysLeft <= 7;
  return (
    <span className={soon ? "num whitespace-nowrap" : "num whitespace-nowrap text-muted-foreground"} title={soon ? `${r.daysLeft} days left` : undefined}>
      {formatDate(r.deadline)}
    </span>
  );
}

const STATUS: Record<TargetRow["status"], { label: string; tone: "neutral" | "buy" | "sell" | "brand" }> = {
  pending: { label: "Pending", tone: "neutral" },
  hit: { label: "Hit", tone: "buy" },
  stopped: { label: "Stopped", tone: "sell" },
  expired: { label: "Missed", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

function Status({ r }: { r: TargetRow }) {
  const st = r.replaced ? { label: "Edited", tone: "neutral" as const } : STATUS[r.status];
  return (
    <Tag tone={st.tone} className={r.status === "cancelled" ? "border-dashed" : undefined}>
      {st.label}
    </Tag>
  );
}

/** Due for review (resolved this week with a thesis and no review yet) links to the symbol page's composer. */
function Actions({ r, due }: { r: TargetRow; due: boolean }) {
  if (!due && !r.canEdit) return null;
  return (
    <span className="flex items-center justify-end gap-0.5">
      {due && (
        <Button asChild variant="ghost" size="icon" className="size-10 text-muted-foreground md:size-8">
          <Link href={`/symbol/${r.instrumentId}?review=${r.id}#journal`} aria-label={`Write review for ${r.symbol} ${r.kind}`} title="Write review">
            <NotebookPenIcon aria-hidden />
          </Link>
        </Button>
      )}
      {r.canEdit && <TargetRowActions instrument={instrumentOf(r)} target={editableOf(r)} label={`${r.symbol} ${r.kind}`} />}
    </span>
  );
}

function MobileRow({ r, due }: { r: TargetRow; due: boolean }) {
  return (
    <div className="flex items-center gap-1 py-3 pr-1 pl-4">
      <Link href={`/symbol/${r.instrumentId}`} className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <span className="text-[13px] font-semibold tracking-[0.01em]">{r.symbol}</span>
            <Tag>{r.kind === "target" ? "Target" : "Stop"}</Tag>
            {r.status !== "pending" && <Status r={r} />}
          </span>
          <Money value={r.price} currency={r.currency} decimals={2} className="text-[13px] font-medium" />
        </span>
        <span className="flex items-baseline justify-between gap-3 text-xs">
          <span className="truncate text-faint">{r.deadline ? `By ${formatDate(r.deadline)}` : `Set ${formatDate(r.setOn)}`}</span>
          <Distance r={r} mobile />
        </span>
      </Link>
      <Actions r={r} due={due} />
    </div>
  );
}

const days = (d: number | null) => (d == null ? <Dash /> : `${Math.round(d)}d`);
const pct = (v: number | null, d = 0) => (v == null ? <Dash /> : formatPercent(v, d));

function Scorecard({ rows }: { rows: ScorecardRow[] }) {
  return (
    <Panel aria-label="Scorecard" className="divide-y">
      {rows.map((r) => (
        <dl key={r.label} className="grid grid-cols-2 gap-x-6 gap-y-4 px-4 py-4 sm:grid-cols-5">
          <div className="col-span-2 flex min-w-0 flex-col gap-1 sm:col-span-1">
            <dt className="text-xs text-muted-foreground">Set by</dt>
            <dd className="truncate text-[13px] font-medium" title={r.label}>
              {r.label}
            </dd>
          </div>
          <Stat label="Hit rate">{pct(r.target.hitRate)}</Stat>
          <Stat label="Days to hit">{days(r.target.medianDaysToHit)}</Stat>
          <Stat label="Avg miss">{pct(r.target.avgMissPct == null ? null : Math.abs(r.target.avgMissPct), 1)}</Stat>
          <Stat label="Stops hit">{pct(r.stop.hitRate)}</Stat>
        </dl>
      ))}
    </Panel>
  );
}

function TargetsSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading targets">
      <div className="flex items-end justify-between">
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-8 w-28" />
      </div>
      <Skeleton className="h-20 rounded-lg" />
      <Skeleton className="h-8 w-72" />
      <div className="flex flex-col gap-px overflow-hidden rounded-lg border">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-13 rounded-none" />
        ))}
      </div>
    </div>
  );
}
