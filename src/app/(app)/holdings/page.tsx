import { InboxIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { BucketSwatch, Chip } from "@/components/chip";
import { EmptyState } from "@/components/empty-state";
import { ExportMenu } from "@/components/export-menu";
import { NoPriceBadge, T1Badge } from "@/components/holding-badges";
import { type Ccy, Delta, Dash, formatAsOf, formatQty, Money, Percent } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Stat, Ticker } from "@/components/panel";
import { Segmented } from "@/components/segmented";
import { type Column, DataTable, type SortDir } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { can, requireActor } from "@/lib/auth/access";
import { getHoldingsView, type HoldingRowDto } from "@/lib/views/holdings";

// Table state lives in the URL (?market=in|us&bucket=<id>&sort=<key>&dir=asc|desc&ccy=usd), so
// it is shareable and survives reload. Defaults are omitted from links to keep URLs clean.
type Market = "all" | "in" | "us";
type State = { market: Market; bucket: string; sort: string; dir: SortDir; ccy: "inr" | "usd" };
const DEFAULT: State = { market: "all", bucket: "", sort: "value", dir: "desc", ccy: "inr" };

function parse(sp: Record<string, string | string[] | undefined>, sortKeys: string[], bucketIds: string[]): State {
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const market = one("market");
  const sort = one("sort");
  const bucket = one("bucket");
  return {
    market: market === "in" || market === "us" ? market : "all",
    bucket: bucket && bucketIds.includes(bucket) ? bucket : "",
    sort: sort && sortKeys.includes(sort) ? sort : DEFAULT.sort,
    dir: one("dir") === "asc" ? "asc" : "desc",
    ccy: one("ccy") === "usd" ? "usd" : "inr",
  };
}

function href(s: State) {
  const q = new URLSearchParams();
  for (const k of ["market", "bucket", "sort", "dir", "ccy"] as const) if (s[k] !== DEFAULT[k]) q.set(k, s[k]);
  const qs = q.toString();
  return qs ? `/holdings?${qs}` : "/holdings";
}

export default function HoldingsPage({ searchParams }: PageProps<"/holdings">) {
  return (
    <Suspense fallback={<HoldingsSkeleton />}>
      <Holdings searchParams={searchParams} />
    </Suspense>
  );
}

/** Amount in the selected display currency: US rows show USD when ccy=usd, INR otherwise. */
const pick = (r: HoldingRowDto, usd: boolean, native: number | null | undefined, inr: number | null | undefined) =>
  usd && r.currency === "USD" ? { v: native, c: "USD" as Ccy } : { v: inr, c: "INR" as Ccy };
const shownReturn = (r: HoldingRowDto, usd: boolean) => (r.currency === "USD" && !usd ? r.returnInrPct : r.returnPct);

/** "10:41 am IST" for a price from today (IST), else "12 Nov, 3:30 pm IST". */
function asOfLabel(iso: string) {
  const day = (d: Date) => d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
  const d = new Date(iso);
  if (day(d) !== day(new Date())) return formatAsOf(iso);
  return `${d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" })} IST`;
}

type Summary = { invested?: number; value?: number; pnl?: number; returnPct: number | null; day?: number; dayPct: number | null };

/** Totals of the rows on screen. Mirrors the view's sumTotals (priced rows only). Needs amounts. */
function summarize(rows: HoldingRowDto[]): Summary {
  const priced = rows.filter((r) => !r.unpriced);
  const sum = (f: (r: HoldingRowDto) => number | null | undefined, rs = priced) => rs.reduce((s, r) => s + (f(r) ?? 0), 0);
  const invested = sum((r) => r.investedInr);
  const value = sum((r) => r.valueInr);
  const withPrev = priced.filter((r) => r.dayChangeInr != null);
  const day = sum((r) => r.dayChangeInr, withPrev);
  const prev = sum((r) => r.valueInr, withPrev) - day;
  return { invested, value, pnl: value - invested, returnPct: invested ? value / invested - 1 : null, day, dayPct: prev ? day / prev : null };
}

async function Holdings({ searchParams }: { searchParams: PageProps<"/holdings">["searchParams"] }) {
  const [actor, view, sp] = await Promise.all([requireActor(), getHoldingsView(), searchParams]);
  const hidden = view.amountsHidden;

  const SORTS: Record<string, (r: HoldingRowDto, usd: boolean) => number | string | null | undefined> = {
    symbol: (r) => r.symbol,
    // Weight orders exactly like INR value and survives redaction.
    value: (r) => r.weightPct,
    weight: (r) => r.weightPct,
    invested: (r) => r.investedInr,
    pnl: hidden ? shownReturn : (r) => r.pnlInr,
    day: (r) => r.dayChangePct,
  };
  const s = parse(
    sp,
    Object.keys(SORTS).filter((k) => !hidden || (k !== "invested" && k !== "weight")),
    view.buckets.map((b) => b.id),
  );
  // USD amounts only make sense when every row on screen is a US row.
  const usd = s.ccy === "usd" && s.market === "us";

  if (view.empty)
    return (
      <div className="flex flex-col gap-8">
        <PageHeader title="Holdings" />
        <EmptyState
          icon={InboxIcon}
          title="No holdings yet"
          action={
            can(actor, "manage") ? (
              <Button asChild className="min-h-10 px-4">
                <Link href="/settings/brokers">Connect a broker</Link>
              </Button>
            ) : undefined
          }
        >
          {can(actor, "manage") ? "Holdings appear after the first broker sync." : "The portfolio has not been synced yet."}
        </EmptyState>
      </div>
    );

  const key = SORTS[s.sort];
  const inBucket = (r: HoldingRowDto) => !s.bucket || r.bucketIds.includes(s.bucket);
  const counts = {
    all: view.rows.filter(inBucket).length,
    in: view.rows.filter((r) => inBucket(r) && r.market === "IN").length,
    us: view.rows.filter((r) => inBucket(r) && r.market === "US").length,
  };
  const rows = view.rows
    .filter((r) => inBucket(r) && (s.market === "all" || r.market === s.market.toUpperCase()))
    .sort((a, b) => {
      const x = key(a, usd);
      const y = key(b, usd);
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1; // missing last
      const c = typeof x === "string" ? x.localeCompare(y as string) : x - (y as number);
      return s.dir === "asc" ? c : -c;
    });
  const bucketName = view.buckets.find((b) => b.id === s.bucket)?.name;

  const num = (c: Omit<Column<HoldingRowDto>, "align">): Column<HoldingRowDto> => ({ ...c, align: "right" });
  const columns: Column<HoldingRowDto>[] = [
    {
      key: "symbol",
      header: "Instrument",
      sortable: true,
      firstDir: "asc",
      mobileSort: true,
      className: "min-w-48",
      cell: (r) => <InstrumentCell r={r} />,
    },
    ...(hidden ? [] : [num({ key: "qty", header: "Qty", cell: (r) => formatQty(r.qty ?? 0) })]),
    num({ key: "avg", header: "Avg cost", cell: (r) => <Money value={r.avgCost} currency={r.currency} decimals={2} /> }),
    num({ key: "day", header: "LTP", sortable: true, cell: (r) => <LtpCell r={r} /> }),
    ...(hidden
      ? []
      : [
          num({
            key: "invested",
            header: "Invested",
            sortable: true,
            cell: (r) => {
              const p = pick(r, usd, r.investedNative, r.investedInr);
              return <Money value={p.v} currency={p.c} />;
            },
          }),
          num({
            key: "value",
            header: "Current",
            sortable: true,
            mobileSort: true,
            cell: (r) => {
              const p = pick(r, usd, r.valueNative, r.valueInr);
              return <Money value={p.v} currency={p.c} className="font-medium" />;
            },
          }),
        ]),
    num({ key: "pnl", header: "P&L", sortable: true, mobileSort: true, cell: (r) => <PnlCell r={r} usd={usd} hidden={hidden} /> }),
    // Hidden amounts: Weight stands in for Current, so it takes the default sort key.
    num({
      key: hidden ? "value" : "weight",
      header: "Weight",
      sortable: true,
      mobileSort: hidden,
      cell: (r) => <Percent value={r.weightPct} decimals={1} className="text-muted-foreground" />,
    }),
  ];

  const totals = view.totals[s.market === "all" ? "all" : s.market === "in" ? "IN" : "US"];
  // Bucket-filtered totals need row amounts; with amounts hidden only the market totals exist.
  const summary: Summary | null = s.bucket
    ? hidden
      ? null
      : summarize(rows)
    : { invested: totals.investedInr, value: totals.valueInr, pnl: totals.pnlInr, returnPct: totals.returnPct, day: totals.dayChangeInr, dayPct: totals.dayChangePct };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Holdings"
        meta={
          <>
            {view.rows.length} {view.rows.length === 1 ? "position" : "positions"}
            {view.priceAsOf && <> · Prices as of {asOfLabel(view.priceAsOf)}</>}
          </>
        }
        actions={
          <>
            {view.totals.IN.count > 0 && view.totals.US.count > 0 && (
              <Segmented
                label="Market"
                options={[
                  { label: `All ${counts.all}`, href: href({ ...s, market: "all" }), active: s.market === "all" },
                  { label: `India ${counts.in}`, href: href({ ...s, market: "in" }), active: s.market === "in" },
                  { label: `US ${counts.us}`, href: href({ ...s, market: "us" }), active: s.market === "us" },
                ]}
              />
            )}
            {s.market === "us" && counts.us > 0 && (
              <Segmented
                label="Show US amounts in"
                options={[
                  { label: "INR", href: href({ ...s, ccy: "inr" }), active: !usd },
                  { label: "USD", href: href({ ...s, ccy: "usd" }), active: usd },
                ]}
              />
            )}
            <ExportMenu kind="holdings" />
          </>
        }
      />

      {summary && <SummaryStrip s={summary} hidden={hidden} />}

      {view.buckets.length > 0 && (
        <nav aria-label="Filter by bucket" className="flex flex-wrap items-center gap-1.5">
          <Chip href={href({ ...s, bucket: "" })} active={!s.bucket}>
            All buckets
          </Chip>
          {view.buckets.map((b) => (
            <Chip key={b.id} href={href({ ...s, bucket: s.bucket === b.id ? "" : b.id })} active={s.bucket === b.id}>
              <BucketSwatch color={b.color} />
              {b.name}
              <span className="num text-faint">{b.count}</span>
            </Chip>
          ))}
        </nav>
      )}

      {rows.length === 0 ? (
        <EmptyState icon={InboxIcon} title={bucketName ? `Nothing open in ${bucketName}` : `No ${s.market === "us" ? "US" : "India"} holdings`} />
      ) : (
        <DataTable
          caption="Holdings"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.instrumentId}
          sort={{ key: s.sort, dir: s.dir }}
          hrefFor={(k, d) => href({ ...s, sort: k, dir: d })}
          mobileRow={(r) => <MobileRow r={r} usd={usd} hidden={hidden} />}
        />
      )}
    </div>
  );
}

function SummaryStrip({ s, hidden }: { s: Summary; hidden: boolean }) {
  const pct = (v: number | null) => <Delta value={v} className={hidden ? undefined : "text-[13px] font-medium"} />;
  const both = (money: number | undefined, p: number | null) =>
    hidden ? (
      pct(p)
    ) : (
      <span className="flex flex-wrap items-baseline gap-x-2">
        <Delta value={money} kind="money" />
        {pct(p)}
      </span>
    );
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-y py-4 sm:grid-cols-4">
      {!hidden && (
        <>
          <Stat label="Invested">
            <Money value={s.invested} />
          </Stat>
          <Stat label="Current">
            <Money value={s.value} />
          </Stat>
        </>
      )}
      <Stat label="P&L">{both(s.pnl, s.returnPct)}</Stat>
      <Stat label="Today">{both(s.day, s.dayPct)}</Stat>
    </dl>
  );
}

function InstrumentCell({ r }: { r: HoldingRowDto }) {
  return (
    <Link
      href={`/symbol/${r.instrumentId}`}
      className="group/i -my-1 flex max-w-64 min-w-0 items-center gap-2 rounded-md py-1 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <Ticker symbol={r.symbol} name={r.name} className="group-hover/i:[&>span:first-child]:text-brand" />
      {r.t1 && <T1Badge />}
      {r.unpriced && <NoPriceBadge />}
    </Link>
  );
}

function LtpCell({ r }: { r: HoldingRowDto }) {
  if (r.price == null) return <Dash label="No price" />;
  return (
    <span className="inline-flex flex-col items-end" title={r.priceAsOf ? `As of ${formatAsOf(r.priceAsOf)}` : undefined}>
      <Money value={r.price} currency={r.currency} decimals={2} />
      <Delta value={r.dayChangePct} className="text-xs" />
    </span>
  );
}

function PnlCell({ r, usd, hidden }: { r: HoldingRowDto; usd: boolean; hidden: boolean }) {
  const pct = <Delta value={shownReturn(r, usd)} className={hidden ? undefined : "text-xs"} />;
  if (hidden) return pct;
  const p = pick(r, usd, r.pnlNative, r.pnlInr);
  return (
    <span className="inline-flex flex-col items-end">
      <Delta value={p.v} kind="money" currency={p.c} />
      {pct}
    </span>
  );
}

function MobileRow({ r, usd, hidden }: { r: HoldingRowDto; usd: boolean; hidden: boolean }) {
  const value = pick(r, usd, r.valueNative, r.valueInr);
  return (
    <Link href={`/symbol/${r.instrumentId}`} className="flex flex-col gap-1.5 px-4 py-3 active:bg-muted/60">
      <div className="flex items-start justify-between gap-4">
        <span className="flex min-w-0 items-center gap-2">
          <Ticker symbol={r.symbol} name={r.name} />
          {r.t1 && <T1Badge />}
          {r.unpriced && <NoPriceBadge />}
        </span>
        <span className="flex shrink-0 flex-col items-end text-[13px]">
          {hidden ? <Percent value={r.weightPct} decimals={1} className="font-medium" /> : <Money value={value.v} currency={value.c} className="font-medium" />}
          <Delta value={shownReturn(r, usd)} className="text-xs" />
        </span>
      </div>
      <div className="num flex items-baseline justify-between gap-4 text-xs text-faint">
        <span className="truncate">
          {hidden ? "Avg " : `${formatQty(r.qty ?? 0)} × `}
          <Money value={r.avgCost} currency={r.currency} decimals={2} />
        </span>
        <span className="flex shrink-0 items-baseline gap-1.5">
          LTP <Money value={r.price} currency={r.currency} decimals={2} />
          <Delta value={r.dayChangePct} />
        </span>
      </div>
    </Link>
  );
}

function HoldingsSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading holdings">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-3.5 w-56" />
        </div>
        <Skeleton className="h-8 w-64" />
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-y py-4 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-5 w-28" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-px overflow-hidden rounded-lg border">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-13 rounded-none" />
        ))}
      </div>
    </div>
  );
}
