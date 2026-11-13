import { LayersIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { BucketSwatch } from "@/components/chip";
import { EmptyState } from "@/components/empty-state";
import { ExportMenu } from "@/components/export-menu";
import { Delta, Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Tag } from "@/components/panel";
import { type Column, DataTable } from "@/components/tables/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { type BucketCard, getBucketsView } from "@/lib/views/buckets";
import { CreateBucket } from "./controls";
import { AlphaFigure, headline, XirrFigure } from "./figures";

export default function BucketsPage() {
  return (
    <Suspense fallback={<BucketsSkeleton />}>
      <Buckets />
    </Suspense>
  );
}

const members = (b: BucketCard) => b.real.count + b.real.unpriced + b.paper.count + b.paper.skipped;

async function Buckets() {
  const view = await getBucketsView();
  const hidden = view.amountsHidden;
  const header = (
    <PageHeader
      title="Buckets"
      actions={
        <>
          {view.buckets.length > 0 && <ExportMenu kind="buckets" />}
          {view.canCreate && <CreateBucket />}
        </>
      }
    />
  );

  if (view.buckets.length === 0)
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState icon={LayersIcon} title="No buckets yet" className="flex-row items-center gap-3 py-6" />
      </div>
    );

  const benchmarks = new Set(view.buckets.flatMap((b) => b.alpha.map((a) => a.label)));
  const columns: Column<BucketCard>[] = [
    { key: "name", header: "Bucket", cell: (b) => <Name b={b} /> },
    { key: "members", header: "Members", align: "right", cell: (b) => members(b) },
    ...(hidden
      ? []
      : ([
          { key: "invested", header: "Invested", align: "right", cell: (b) => (b.real.count ? <Money value={b.real.costInr} /> : <Money value={null} />) },
          { key: "current", header: "Current", align: "right", cell: (b) => (b.real.count ? <Money value={b.real.valueInr} /> : <Money value={null} />) },
        ] satisfies Column<BucketCard>[])),
    { key: "return", header: "Return", align: "right", cell: (b) => <Delta value={headline(b).returnPct} /> },
    { key: "xirr", header: "XIRR", align: "right", cell: (b) => <XirrFigure {...headline(b)} /> },
    { key: "alpha", header: benchmarks.size === 1 ? `vs ${[...benchmarks][0]}` : "Alpha", align: "right", cell: (b) => <Alphas b={b} /> },
  ];

  return (
    <div className="flex flex-col gap-6">
      {header}
      <DataTable
        caption="Buckets"
        columns={columns}
        rows={view.buckets}
        rowKey={(b) => b.id}
        sort={{ key: "", dir: "desc" }}
        hrefFor={() => "/buckets"}
        mobileRow={(b) => (
          <Link href={`/buckets/${b.id}`} className="flex flex-col gap-1 px-4 py-3">
            <span className="flex items-baseline justify-between gap-3">
              <Name b={b} plain />
              <Delta value={headline(b).returnPct} className="text-[13px] font-medium" />
            </span>
            <span className="flex items-baseline justify-between gap-3 text-xs">
              <span className="text-faint">
                {members(b)} {members(b) === 1 ? "member" : "members"}
                {!hidden && b.real.count > 0 && (
                  <>
                    , <Money value={b.real.valueInr} />
                  </>
                )}
              </span>
              <Alphas b={b} />
            </span>
          </Link>
        )}
      />
    </div>
  );
}

function Name({ b, plain = false }: { b: BucketCard; plain?: boolean }) {
  const inner = (
    <>
      <BucketSwatch color={b.color} />
      <span className="truncate font-medium">{b.name}</span>
      {b.real.count === 0 && b.paper.count > 0 && <Tag>Paper</Tag>}
    </>
  );
  if (plain) return <span className="flex min-w-0 items-center gap-2 text-[13px]">{inner}</span>;
  return (
    <Link href={`/buckets/${b.id}`} className="flex max-w-72 min-w-0 items-center gap-2 underline-offset-4 hover:[&>span:nth-child(2)]:underline">
      {inner}
    </Link>
  );
}

function Alphas({ b }: { b: BucketCard }) {
  if (!b.alpha.length) return <Money value={null} />;
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      {b.alpha.map((a) => (
        <span key={a.market} className="inline-flex items-baseline gap-1.5" title={`vs ${a.label}`}>
          {b.alpha.length > 1 && <span className="text-xs text-faint">{a.label}</span>}
          <AlphaFigure a={a} />
        </span>
      ))}
    </span>
  );
}

function BucketsSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading buckets">
      <div className="flex items-end justify-between">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-8 w-28" />
      </div>
      <div className="flex flex-col gap-px overflow-hidden rounded-lg border">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-13 rounded-none" />
        ))}
      </div>
    </div>
  );
}
