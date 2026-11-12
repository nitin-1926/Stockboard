import Link from "next/link";
import { PnlHeatmap } from "@/components/charts/pnl-heatmap";
import { ValueArea } from "@/components/charts/value-area";
import { type BarRow, WeightBars } from "@/components/charts/weight-bars";
import { Delta, formatDate, formatMoney, formatPercent, Money } from "@/components/money";
import { Panel, PanelHeader, Tag, Ticker } from "@/components/panel";
import { Segmented } from "@/components/segmented";
import { type DueReview, getDueReviews } from "@/lib/journal/due-reviews";
import { getAllocationView, UNCLASSIFIED } from "@/lib/views/allocation";
import { HISTORY_RANGES, type HistoryRange, type HistoryView } from "@/lib/views/history";
import type { HoldingRowDto } from "@/lib/views/holdings";
import { ClassifySectors } from "./classify-sectors";

export const DEFAULT_RANGE: HistoryRange = "1y";
const RANGE_LABEL: Record<HistoryRange, string> = { "1m": "1M", "3m": "3M", "6m": "6M", "1y": "1Y", all: "All" };

/** Faint one-liner inside a panel, in place of a big empty box. */
function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-5 text-[13px] text-muted-foreground">{children}</p>;
}

/** Sub-heading inside a panel body (Gainers, Losers, Holdings, Sectors). */
function SubHead({ children }: { children: React.ReactNode }) {
  return <h3 className="px-4 pt-3 pb-1 text-xs text-muted-foreground">{children}</h3>;
}

export async function ValueChart({ history, range }: { history: Promise<HistoryView>; range: HistoryRange }) {
  const v = await history;
  const series = v.scopes.all;
  const pts = series.points;
  const hidden = v.amountsHidden;
  const first = pts[0];
  const last = pts.at(-1);
  const label =
    first && last
      ? hidden
        ? `Index from 100 on ${formatDate(first.date)} to ${last.index.toFixed(1)} on ${formatDate(last.date)}`
        : `Value from ${formatMoney(first.value ?? 0, "INR")} on ${formatDate(first.date)} to ${formatMoney(last.value ?? 0, "INR")} on ${formatDate(last.date)}`
      : "";

  return (
    <Panel aria-labelledby="perf">
      <PanelHeader
        id="perf"
        title={
          <span className="flex items-baseline gap-2.5">
            Performance
            {pts.length > 1 && <Delta value={series.summary.returnPct} className="text-[13px] font-medium" />}
          </span>
        }
      >
        <Segmented
          label="Range"
          options={HISTORY_RANGES.map((k) => ({ label: RANGE_LABEL[k], href: k === DEFAULT_RANGE ? "/" : `/?range=${k}`, active: k === range }))}
        />
      </PanelHeader>
      {pts.length < 2 ? (
        <Quiet>Chart starts after a few days of daily snapshots.</Quiet>
      ) : (
        <div className="px-2 pt-4 pb-2 sm:px-4">
          <ValueArea points={pts.map((p) => ({ date: p.date, value: p.value, index: p.index, dayPnlPct: p.dayPnlPct }))} hidden={hidden} label={label} />
        </div>
      )}
    </Panel>
  );
}

export async function Heatmap({ history }: { history: Promise<HistoryView> }) {
  const v = await history;
  const series = v.scopes.all;
  // Same bar as the chart: a calendar of one day says nothing.
  if (series.points.filter((p) => p.dayPnlPct != null).length < 2) return null;
  const m = series.summary;
  return (
    <Panel aria-labelledby="daily">
      <PanelHeader id="daily" title="Daily P&L">
        <span className="num">
          {m.upDays} up, {m.downDays} down
        </span>
      </PanelHeader>
      <div className="p-4">
        <PnlHeatmap
          caption="Daily profit and loss calendar"
          days={series.points.map((p) => ({ date: p.date, pct: p.dayPnlPct, ...(v.amountsHidden ? {} : { pnl: p.dayPnl }) }))}
        />
      </div>
    </Panel>
  );
}

function MoverList({ rows }: { rows: HoldingRowDto[] }) {
  return (
    <ul>
      {rows.map((r) => (
        <li key={r.instrumentId}>
          <Link
            href={`/symbol/${r.instrumentId}`}
            className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto_4.5rem] items-center gap-4 px-4 py-1.5 transition-colors hover:bg-muted/60"
          >
            <Ticker symbol={r.symbol} name={r.name} />
            <Money value={r.price} currency={r.currency} decimals={2} className="text-[13px] text-muted-foreground" />
            <Delta value={r.dayChangePct} className="text-right text-[13px] font-medium" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function Movers({ rows }: { rows: HoldingRowDto[] }) {
  const moved = rows.filter((r) => r.dayChangePct != null && r.dayChangePct !== 0).sort((a, b) => b.dayChangePct! - a.dayChangePct!);
  const gainers = moved.filter((r) => r.dayChangePct! > 0).slice(0, 5);
  const losers = moved.filter((r) => r.dayChangePct! < 0).slice(-5).reverse();
  return (
    <Panel aria-labelledby="movers">
      <PanelHeader id="movers" title="Today's movers" />
      {!moved.length ? (
        <Quiet>No price moves yet today.</Quiet>
      ) : (
        <div className="flex flex-col pb-2">
          {gainers.length > 0 && (
            <>
              <SubHead>Gainers</SubHead>
              <MoverList rows={gainers} />
            </>
          )}
          {losers.length > 0 && (
            <>
              <SubHead>Losers</SubHead>
              <MoverList rows={losers} />
            </>
          )}
        </div>
      )}
    </Panel>
  );
}

const TOP_HOLDINGS = 10;

export async function Allocation() {
  const v = await getAllocationView();
  const top = v.byStock.slice(0, TOP_HOLDINGS);
  const rest = v.byStock.slice(TOP_HOLDINGS);
  const holdings: BarRow[] = [
    ...top.map((g) => ({ key: g.key, label: g.label, weightPct: g.weightPct, href: `/symbol/${g.key}` })),
    ...(rest.length ? [{ key: "rest", label: `${rest.length} others`, weightPct: rest.reduce((s, g) => s + g.weightPct, 0), muted: true }] : []),
  ];
  const sectors = v.bySector.some((g) => g.key !== UNCLASSIFIED) ? v.bySector : [];

  return (
    <Panel aria-labelledby="alloc">
      <PanelHeader id="alloc" title="Allocation">
        {v.canManage && v.unclassified.length > 0 && <ClassifySectors />}
      </PanelHeader>
      {!holdings.length ? (
        <Quiet>Weights appear once holdings have a price.</Quiet>
      ) : (
        <div className="flex flex-col pb-3">
          <SubHead>Holdings</SubHead>
          <div className="px-4">
            <WeightBars label="Share by holding" limit={v.limits.stockPct} rows={holdings} />
          </div>
          {sectors.length > 0 && (
            <>
              <SubHead>Sectors</SubHead>
              <div className="px-4">
                <WeightBars
                  label="Share by sector"
                  limit={v.limits.sectorPct}
                  rows={sectors.map((g) => ({ key: g.key, label: g.label, weightPct: g.weightPct, muted: g.key === UNCLASSIFIED }))}
                />
              </div>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}

const OUTCOME: Record<DueReview["outcome"], { label: string; tone: "buy" | "sell" | "neutral" }> = {
  hit: { label: "Hit", tone: "buy" },
  stopped: { label: "Stopped", tone: "sell" },
  expired: { label: "Expired", tone: "neutral" },
};
const ago = (d: number) => (d === 0 ? "today" : d === 1 ? "yesterday" : `${d}d ago`);

/** Resolved targets from the last week with a thesis and no review yet. Hidden when empty or for viewers. */
export async function DueForReview() {
  const items = await getDueReviews();
  if (!items.length) return null;
  return (
    <Panel aria-labelledby="due">
      <PanelHeader id="due" title="Due for review">
        <span className="num">{items.length}</span>
      </PanelHeader>
      <ul className="divide-y">
        {items.map((d) => (
          <li key={d.targetId} className="flex min-h-12 items-center gap-3 px-4 py-2 text-[13px]">
            <Link href={`/symbol/${d.instrumentId}`} className="font-semibold tracking-[0.01em] hover:underline hover:underline-offset-4">
              {d.symbol}
            </Link>
            <Tag tone={OUTCOME[d.outcome].tone}>{OUTCOME[d.outcome].label}</Tag>
            <span className="min-w-0 truncate text-muted-foreground">
              {d.kind === "target" ? "Target" : "Stop"} <Money value={d.price} currency={d.currency} decimals={2} />
              {d.missPct != null && `, missed by ${formatPercent(Math.abs(d.missPct), 1)}`}
            </span>
            <span className="ml-auto shrink-0 text-xs text-faint">{ago(d.daysSince)}</span>
            <Link
              href={`/symbol/${d.instrumentId}?review=${d.targetId}#journal`}
              className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-foreground hover:bg-muted"
            >
              Review<span className="sr-only"> {d.symbol}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
