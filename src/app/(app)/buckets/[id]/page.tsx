import { LayersIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { BenchmarkChart } from "@/components/charts/benchmark-chart";
import { BucketSwatch } from "@/components/chip";
import { EmptyState } from "@/components/empty-state";
import { Dash, Delta, formatDate, formatMoney, Money, Percent } from "@/components/money";
import { Panel, PanelHeader, Stat, Tag, Ticker } from "@/components/panel";
import { type Column, DataTable } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { type BucketChart, type BucketDetail, getBucketDetailView } from "@/lib/views/buckets";
import { AddMembers, BucketMenu, RemoveMember } from "../controls";
import { AlphaFigure, headline, XirrFigure } from "../figures";

type Member = {
  id: string;
  kind: "real" | "paper";
  instrumentId: string;
  symbol: string;
  name: string;
  since: string;
  sold: boolean;
  weight: number | null;
  returnPct: number | null;
  skipped: string | null;
  canRemove: boolean;
  label: string;
};

export default function BucketPage({ params }: PageProps<"/buckets/[id]">) {
  return (
    <Suspense fallback={<DetailSkeleton />}>
      <Bucket params={params} />
    </Suspense>
  );
}

async function Bucket({ params }: { params: PageProps<"/buckets/[id]">["params"] }) {
  const { id } = await params;
  const b = await getBucketDetailView(id);
  if (!b) notFound();
  const empty = b.realMembers.length === 0 && b.paperMembers.length === 0;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <Link href="/buckets" className="inline-flex min-h-10 w-fit items-center text-xs text-faint hover:text-foreground md:min-h-0">
          Buckets
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="flex items-center gap-2.5 text-xl font-semibold tracking-[-0.015em]">
              <BucketSwatch color={b.color} className="size-3" />
              <span className="min-w-0 break-words">{b.name}</span>
            </h1>
            {b.description && <p className="max-w-prose text-xs text-faint">{b.description}</p>}
          </div>
          <BucketMenu
            bucket={{ id: b.id, name: b.name, description: b.description, color: b.color }}
            canEdit={b.canEdit}
            canArchive={b.canArchive}
            members={b.canAddMember ? b.options : null}
          />
        </div>
      </div>

      {empty ? (
        <EmptyState
          icon={LayersIcon}
          title="Nothing in this bucket yet"
          className="flex-row items-center gap-3 py-6"
          action={
            b.canAddMember && (
              <AddMembers bucketId={b.id} lots={b.options.lots} watch={b.options.watch}>
                <Button className="ml-auto h-10 md:h-8">
                  <PlusIcon aria-hidden />
                  Add members
                </Button>
              </AddMembers>
            )
          }
        />
      ) : (
        <>
          <Summary b={b} />
          {b.chart && <ChartPanel chart={b.chart} />}
          <Members b={b} />
        </>
      )}
    </div>
  );
}

function Summary({ b }: { b: BucketDetail }) {
  const r = b.real;
  const hasReal = b.realMembers.length > 0;
  const hidden = b.amountsHidden;
  const h = headline(b);
  return (
    <Panel aria-label="Summary">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 px-4 py-4 sm:grid-cols-3 lg:flex lg:flex-wrap lg:gap-x-12">
        {hasReal && !hidden && (
          <>
            <Stat label="Invested">
              <Money value={r.costInr} />
            </Stat>
            <Stat label="Current">
              <Money value={r.valueInr} />
            </Stat>
          </>
        )}
        <Stat label={hasReal ? "Return" : "Paper return"}>
          <Delta value={h.returnPct} />
        </Stat>
        <Stat label="XIRR">
          <XirrFigure {...h} />
        </Stat>
        {hasReal && (
          <Stat label="Realized">
            {hidden ? <Percent value={r.realizedPct} decimals={1} /> : <Delta value={r.realizedInr} kind="money" />}
          </Stat>
        )}
        {b.alpha.map((a) => (
          <Stat key={a.market} label={`Alpha vs ${a.label}`}>
            <AlphaFigure a={a} />
          </Stat>
        ))}
        {hasReal && b.paperMembers.length > 0 && (
          <Stat label="Paper return">
            <Delta value={b.paper.returnPct} />
          </Stat>
        )}
      </dl>
    </Panel>
  );
}

function chartSummary(c: BucketChart) {
  const first = c.points[0];
  const last = c.points.at(-1)!;
  const fmt = (v: number) => (c.normalized ? v.toFixed(1) : formatMoney(v, "INR"));
  const own = `From ${formatDate(first.date)} to ${formatDate(last.date)}, this bucket went from ${fmt(first.portfolio)} to ${fmt(last.portfolio)}.`;
  return c.benchmarkPending ? own : `${own} The same cash flows in ${c.benchmarkLabel} would be ${fmt(last.benchmark ?? 0)}.`;
}

function ChartPanel({ chart }: { chart: BucketChart }) {
  return (
    <Panel aria-labelledby="vs-index">
      <PanelHeader title={`vs ${chart.benchmarkLabel}`} id="vs-index">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-0.5 w-3 rounded-full bg-brand" />
          This bucket
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="w-3 border-t-[1.5px] border-dashed border-faint" />
          {chart.benchmarkLabel}
          {chart.benchmarkPending && <span className="text-faint">pending</span>}
        </span>
        {chart.normalized && <span className="text-faint">per ₹100</span>}
      </PanelHeader>
      <p className="sr-only">{chartSummary(chart)}</p>
      <div className="px-2 pt-4 pb-2 sm:px-4">
        <BenchmarkChart points={chart.points} normalized={chart.normalized} benchmarkLabel={chart.benchmarkLabel} />
      </div>
    </Panel>
  );
}

function members(b: BucketDetail): Member[] {
  // ponytail: weight needs INR value, which hide-amounts redacts; blank for those viewers until the view computes it.
  const total = b.realMembers.reduce((s, m) => s + (m.status === "sold" ? 0 : (m.valueInr ?? 0)), 0);
  const real: Member[] = b.realMembers.map((m) => ({
    id: m.id,
    kind: "real",
    instrumentId: m.instrumentId,
    symbol: m.symbol,
    name: m.name,
    since: m.boughtOn,
    sold: m.status === "sold",
    weight: m.status !== "sold" && m.valueInr != null && total > 0 ? m.valueInr / total : null,
    returnPct: m.returnPct,
    skipped: null,
    canRemove: m.canRemove,
    label: `${m.symbol} (${formatDate(m.boughtOn)})`,
  }));
  const paper: Member[] = b.paperMembers.map((m) => ({
    id: m.id,
    kind: "paper",
    instrumentId: m.instrumentId,
    symbol: m.symbol,
    name: m.name,
    since: m.addedOn,
    sold: false,
    weight: null,
    returnPct: m.skipped ? null : m.returnPct,
    skipped: m.skipped,
    canRemove: m.canRemove,
    label: `${m.symbol} (paper)`,
  }));
  return [...real, ...paper];
}

function KindTag({ m }: { m: Member }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Tag>{m.kind === "real" ? "Real" : "Paper"}</Tag>
      {m.sold && <span className="text-xs text-faint">sold</span>}
    </span>
  );
}

function Members({ b }: { b: BucketDetail }) {
  const rows = members(b);
  const removable = rows.some((m) => m.canRemove);
  const ret = (m: Member) => (m.skipped ? <Dash label={`Not counted: ${m.skipped}`} /> : <Delta value={m.returnPct} />);
  const remove = (m: Member) => (m.canRemove ? <RemoveMember bucketId={b.id} memberId={m.id} label={m.label} /> : null);
  const columns: Column<Member>[] = [
    {
      key: "symbol",
      header: "Instrument",
      cell: (m) => (
        <Link href={`/symbol/${m.instrumentId}`} className="block w-fit max-w-64 underline-offset-4 hover:[&>span>span:first-child]:underline">
          <Ticker symbol={m.symbol} name={m.name} />
        </Link>
      ),
    },
    { key: "kind", header: "Kind", cell: (m) => <KindTag m={m} /> },
    { key: "since", header: "Since", cell: (m) => <span className="num whitespace-nowrap text-faint">{formatDate(m.since)}</span> },
    ...(b.amountsHidden ? [] : [{ key: "weight", header: "Weight", align: "right", cell: (m) => <Percent value={m.weight} decimals={1} /> } satisfies Column<Member>]),
    { key: "return", header: "Return", align: "right", cell: ret },
    ...(removable ? [{ key: "remove", header: "", className: "w-10", cell: remove } satisfies Column<Member>] : []),
  ];
  return (
    <section aria-labelledby="members" className="flex flex-col gap-3">
      <h2 id="members" className="text-sm font-semibold">
        Members <span className="num font-normal text-faint">{rows.length}</span>
      </h2>
      <DataTable
        caption="Members"
        columns={columns}
        rows={rows}
        rowKey={(m) => m.id}
        sort={{ key: "", dir: "asc" }}
        hrefFor={() => `/buckets/${b.id}`}
        mobileRow={(m) => (
          <div className="flex items-center gap-1 py-3 pr-1 pl-4">
            <Link href={`/symbol/${m.instrumentId}`} className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex items-baseline justify-between gap-3">
                <span className="text-[13px] font-semibold tracking-[0.01em]">{m.symbol}</span>
                <span className="text-[13px] font-medium">{ret(m)}</span>
              </span>
              <span className="flex items-baseline justify-between gap-3 text-xs text-faint">
                <span>
                  {m.kind === "real" ? "Real" : "Paper"}, {formatDate(m.since)}
                  {m.sold && ", sold"}
                </span>
                {m.weight != null && <Percent value={m.weight} decimals={1} />}
              </span>
            </Link>
            {remove(m)}
          </div>
        )}
        footer={
          b.real.unpriced > 0 && (
            <p className="text-xs text-faint">
              {b.real.unpriced} unpriced {b.real.unpriced === 1 ? "lot is" : "lots are"} left out of the totals.
            </p>
          )
        }
      />
    </section>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true" aria-label="Loading bucket">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-14" />
        <Skeleton className="h-7 w-48" />
      </div>
      <Skeleton className="h-20 rounded-lg" />
      <Skeleton className="h-80 rounded-lg" />
      <div className="flex flex-col gap-px overflow-hidden rounded-lg border">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-13 rounded-none" />
        ))}
      </div>
    </div>
  );
}
