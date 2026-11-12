import { HourglassIcon, InboxIcon } from "lucide-react";
import Link from "next/link";
import { type ReactNode, Suspense } from "react";
import { EmptyState } from "@/components/empty-state";
import { Delta, formatAsOf, Money } from "@/components/money";
import { Panel, Stat } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { can, requireActor } from "@/lib/auth/access";
import { cn } from "@/lib/utils";
import { getConnectionsView } from "@/lib/views/connections";
import { getHistoryView, HISTORY_RANGES } from "@/lib/views/history";
import { getHoldingsView, type HoldingsView, type TotalsDto } from "@/lib/views/holdings";
import { getMarginsView, type MarginsView } from "@/lib/views/margins";
import { Allocation, DEFAULT_RANGE, DueForReview, Heatmap, Movers, ValueChart } from "./_overview/sections";

export default function OverviewPage({ searchParams }: PageProps<"/">) {
  return (
    <Suspense fallback={<OverviewSkeleton />}>
      <Overview searchParams={searchParams} />
    </Suspense>
  );
}

async function Overview({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  const { range: r } = await searchParams;
  const range = HISTORY_RANGES.find((k) => k === r) ?? DEFAULT_RANGE;
  const [actor, view, conns, margins] = await Promise.all([requireActor(), getHoldingsView(), getConnectionsView(), getMarginsView()]);
  const owner = can(actor, "manage");
  if (view.empty)
    return (
      <>
        <h1 className="sr-only">Overview</h1>
        <NoHoldings owner={owner} anyConnected={!!conns?.anyConnected} />
      </>
    );
  // One history load feeds both the chart and the calendar.
  const history = getHistoryView(range);

  return (
    <div className="flex flex-col gap-8">
      <h1 className="sr-only">Overview</h1>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,34rem)] lg:items-end lg:gap-8">
        <Hero view={view} />
        <Kpis view={view} margins={margins} />
      </div>

      <Suspense fallback={<Skeleton className="h-[21rem] rounded-lg sm:h-[25rem]" />}>
        <ValueChart history={history} range={range} />
      </Suspense>

      <div className="grid gap-6 md:grid-cols-2">
        <Movers rows={view.rows} />
        <Suspense fallback={<Skeleton className="h-96 rounded-lg" />}>
          <Allocation />
        </Suspense>
      </div>

      <Markets view={view} owner={owner} />

      <Suspense fallback={null}>
        <Heatmap history={history} />
      </Suspense>
      <Suspense fallback={null}>
        <DueForReview />
      </Suspense>
    </div>
  );
}

function Hero({ view }: { view: HoldingsView }) {
  const t = view.totals.all;
  const hidden = view.amountsHidden;
  return (
    <section aria-labelledby="hero-label" className="flex min-w-0 flex-col">
      <p id="hero-label" className="text-[13px] text-muted-foreground">
        {hidden ? "Portfolio return" : "Portfolio value"}
      </p>
      <p className="mt-2 text-[2.75rem] leading-none font-semibold tracking-[-0.03em] sm:text-[3.25rem]">
        {hidden ? <Delta value={t.returnPct} /> : <Money value={t.valueInr} />}
      </p>
      <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-1.5 text-[13px]">
        <div className="flex items-baseline gap-2">
          <dt className="text-muted-foreground">Today</dt>
          <dd className="flex items-baseline gap-2 font-medium">
            {!hidden && <Delta value={t.dayChangeInr} kind="money" />}
            <Delta value={t.dayChangePct} />
          </dd>
        </div>
        {!hidden && (
          <div className="flex items-baseline gap-2">
            <dt className="text-muted-foreground">Total P&amp;L</dt>
            <dd className="flex items-baseline gap-2 font-medium">
              <Delta value={t.pnlInr} kind="money" />
              <Delta value={t.returnPct} />
            </dd>
          </div>
        )}
      </dl>
      <p className="mt-3 flex flex-wrap gap-x-3 text-xs text-faint">
        <span>{t.priceAsOf ? `Prices as of ${formatAsOf(t.priceAsOf)}` : "No prices yet"}</span>
        {view.fx && <span className="num">USD/INR {view.fx.usdInr.toFixed(2)}</span>}
      </p>
    </section>
  );
}

/** Hide-amounts viewers get returns only: the view already redacted every amount. */
function Kpis({ view, margins }: { view: HoldingsView; margins: MarginsView | null }) {
  const t = view.totals.all;
  const stats: [string, ReactNode][] = view.amountsHidden
    ? [
        ["Return", <Delta key="r" value={t.returnPct} />],
        ["Today", <Delta key="d" value={t.dayChangePct} />],
        ["Holdings", t.pricedCount],
      ]
    : [
        ["Invested", <Money key="i" value={t.investedInr} />],
        ["Current value", <Money key="v" value={t.valueInr} />],
        ["Unrealized P&L", <Delta key="p" value={t.pnlInr} kind="money" />],
        ["Day's P&L", <Delta key="d" value={t.dayChangeInr} kind="money" />],
        ["Holdings", t.pricedCount],
        margins?.cash != null ? ["Available cash", <Money key="c" value={margins.cash} />] : ["Return", <Delta key="r" value={t.returnPct} />],
      ];
  return (
    <Panel aria-label="Key figures" className="overflow-hidden">
      <dl className={cn("grid gap-px bg-border", view.amountsHidden ? "grid-cols-3" : "grid-cols-2 sm:grid-cols-3")}>
        {stats.map(([label, value]) => (
          <Stat key={label} label={label} className="bg-card px-4 py-3">
            {value}
          </Stat>
        ))}
      </dl>
    </Panel>
  );
}

function Markets({ view, owner }: { view: HoldingsView; owner: boolean }) {
  return (
    <Panel aria-label="Markets" className="grid md:grid-cols-2">
      <Market name="India" t={view.totals.IN} hidden={view.amountsHidden} owner={owner} />
      <Market name="US" t={view.totals.US} hidden={view.amountsHidden} owner={owner} className="border-t md:border-t-0 md:border-l" />
    </Panel>
  );
}

function Market({ name, t, hidden, owner, className }: { name: string; t: TotalsDto; hidden: boolean; owner: boolean; className?: string }) {
  return (
    <div className={cn("flex min-h-[4.5rem] flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-6", className)}>
      <h2 className="shrink-0 text-sm font-semibold sm:w-14">{name}</h2>
      {t.count === 0 ? (
        <div className="flex flex-1 items-center justify-between gap-3">
          <span className="text-[13px] text-muted-foreground">Not connected</span>
          {owner && (
            <Button asChild variant="outline" size="sm" className="h-7 text-xs">
              <Link href="/settings/brokers">Connect</Link>
            </Button>
          )}
        </div>
      ) : (
        <dl className="grid flex-1 grid-cols-3 gap-4">
          {hidden ? (
            <Stat label="Holdings">{t.pricedCount}</Stat>
          ) : (
            <Stat label="Value">
              <Money value={t.valueInr} />
            </Stat>
          )}
          <Stat label="P&L">
            <Delta value={t.returnPct} />
          </Stat>
          <Stat label="Today">
            <Delta value={t.dayChangePct} />
          </Stat>
        </dl>
      )}
    </div>
  );
}

function NoHoldings({ owner, anyConnected }: { owner: boolean; anyConnected: boolean }) {
  if (owner && !anyConnected)
    return (
      <EmptyState
        icon={InboxIcon}
        title="No holdings yet"
        action={
          <Button asChild size="sm">
            <Link href="/settings/brokers">Connect a broker</Link>
          </Button>
        }
      >
        The first sync fills this page.
      </EmptyState>
    );
  return (
    <EmptyState icon={HourglassIcon} title={owner ? "Waiting for the first sync" : "Nothing to show yet"}>
      {owner ? "Holdings appear after the next scheduled sync." : "Check back after the portfolio syncs."}
    </EmptyState>
  );
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true" aria-label="Loading overview">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,34rem)] lg:items-end lg:gap-8">
        <div className="flex flex-col">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="mt-2 h-11 w-72 max-w-full sm:h-13" />
          <Skeleton className="mt-4 h-4 w-80 max-w-full" />
          <Skeleton className="mt-3 h-3 w-48" />
        </div>
        <Skeleton className="h-[8.5rem] rounded-lg sm:h-[8.25rem]" />
      </div>
      <Skeleton className="h-[21rem] rounded-lg sm:h-[25rem]" />
      <div className="grid gap-6 md:grid-cols-2">
        <Skeleton className="h-96 rounded-lg" />
        <Skeleton className="h-96 rounded-lg" />
      </div>
      <Skeleton className="h-[4.5rem] rounded-lg" />
    </div>
  );
}
