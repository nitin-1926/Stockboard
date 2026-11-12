import { ArrowLeftRightIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { EmptyState } from "@/components/empty-state";
import { ExportMenu } from "@/components/export-menu";
import { type Ccy, formatDate, formatQty, Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Panel, PanelHeader, Stat, Tag, Ticker } from "@/components/panel";
import { Can } from "@/components/can";
import { Skeleton } from "@/components/ui/skeleton";
import { getDailyTradesView, type DailyTradeRowDto } from "@/lib/views/trades";
import { SyncNowButton } from "./sync-button";

// Buys and sells only (broker fills, tradebook imports). Today first, then the last 30 days.
export default function TradesPage() {
  return (
    <Suspense fallback={<TradesSkeleton />}>
      <Trades />
    </Suspense>
  );
}

/** One line per instrument and side: Kite reports each partial fill separately. */
type Line = Omit<DailyTradeRowDto, "qty" | "valueNative"> & { qty: number | null; valueNative: number | null; fills: number };
function combine(rows: DailyTradeRowDto[]): Line[] {
  const out = new Map<string, Line>();
  for (const r of rows) {
    const key = `${r.instrumentId}:${r.side}`;
    const prev = out.get(key);
    if (!prev) {
      out.set(key, { ...r, qty: r.qty ?? null, valueNative: r.valueNative ?? null, fills: 1 });
      continue;
    }
    prev.fills += 1;
    prev.qty = prev.qty != null && r.qty != null ? prev.qty + r.qty : null;
    prev.valueNative = prev.valueNative != null && r.valueNative != null ? prev.valueNative + r.valueNative : null;
    // Rows arrive newest first: keep the earliest fill time for the order.
    if (r.executedAt < prev.executedAt) prev.executedAt = r.executedAt;
    prev.price = prev.qty && prev.valueNative != null ? prev.valueNative / prev.qty : prev.price;
  }
  return [...out.values()].sort((a, b) => (a.executedAt < b.executedAt ? 1 : -1));
}
const dayTotals = (rows: DailyTradeRowDto[]) => {
  let buy = 0;
  let sell = 0;
  for (const r of rows) {
    if (r.side === "buy") buy += r.valueInr ?? 0;
    else sell += r.valueInr ?? 0;
  }
  return { buy, sell };
};

const TIME = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });
const timeOf = (iso: string) => (iso.length > 10 ? TIME.format(new Date(iso)) : null);

async function Trades() {
  const v = await getDailyTradesView({ days: 30 });
  const { today, earlier } = v;
  const live = v.markets.IN.open || v.markets.US.open;
  const todayLines = combine(today.rows);
  const buys = todayLines.filter((r) => r.side === "buy").length;
  const sells = todayLines.length - buys;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Trades"
        meta={`Today, ${formatDate(today.date)}`}
        actions={
          <>
            <Suspense fallback={null}>
              <Can action="manage">
                <SyncNowButton />
              </Can>
            </Suspense>
            <ExportMenu kind="trades" />
          </>
        }
      />

      <Panel aria-labelledby="today">
        <PanelHeader id="today" title="Today">
          {live && <span>Live</span>}
        </PanelHeader>
        {today.rows.length === 0 ? (
          <p className="px-4 py-6 text-[13px] text-muted-foreground">No buys or sells today.</p>
        ) : (
          <>
            {!v.amountsHidden && (
              <dl className="grid grid-cols-2 gap-4 border-b px-4 py-4 sm:grid-cols-4">
                <Stat label={`Bought (${buys})`}>
                  <Money value={today.buyValueInr} />
                </Stat>
                <Stat label={`Sold (${sells})`}>
                  <Money value={today.sellValueInr} />
                </Stat>
              </dl>
            )}
            <TradeTable rows={todayLines} withTime />
          </>
        )}
      </Panel>

      {earlier.length > 0 && (
        <section aria-labelledby="earlier" className="flex flex-col gap-3">
          <h2 id="earlier" className="text-sm font-semibold">
            Last 30 days
          </h2>
          {earlier.map((day) => (
            <Panel key={day.date} aria-label={formatDate(day.date)}>
              <PanelHeader title={formatDate(day.date)}>
                {!v.amountsHidden && <DayTotals rows={day.rows} />}
              </PanelHeader>
              <TradeTable rows={combine(day.rows)} />
            </Panel>
          ))}
        </section>
      )}

      {today.rows.length === 0 && earlier.length === 0 && (
        <EmptyState icon={ArrowLeftRightIcon} title="No trades in the last 30 days">
          Buys and sells appear after the next Kite sync.
        </EmptyState>
      )}
    </div>
  );
}

function DayTotals({ rows }: { rows: DailyTradeRowDto[] }) {
  const t = dayTotals(rows);
  return (
    <span className="num flex gap-4">
      {t.buy > 0 && (
        <span>
          Bought <Money value={t.buy} className="text-foreground" />
        </span>
      )}
      {t.sell > 0 && (
        <span>
          Sold <Money value={t.sell} className="text-foreground" />
        </span>
      )}
    </span>
  );
}

function TradeTable({ rows, withTime }: { rows: Line[]; withTime?: boolean }) {
  return (
    <>
      {/* Phones: one compact line per trade. */}
      <ul className="divide-y md:hidden">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <SideTag side={r.side} />
              <Link href={`/symbol/${r.instrumentId}`} className="min-w-0">
                <Ticker symbol={r.symbol} name={r.name} />
              </Link>
            </div>
            <div className="flex flex-col items-end text-right">
              <span className="num text-[13px] font-medium">
                <Money value={r.valueNative} currency={r.currency as Ccy} decimals={2} />
              </span>
              <span className="num text-xs text-muted-foreground">
                {r.qty != null && <>{formatQty(r.qty)} × </>}
                <Money value={r.price} currency={r.currency as Ccy} decimals={2} />
              </span>
            </div>
          </li>
        ))}
      </ul>

      <table className="hidden w-full text-[13px] md:table">
        <thead>
          <tr className="border-b text-xs text-muted-foreground">
            {withTime && <th className="h-9 w-24 pl-4 text-left font-medium">Time</th>}
            <th className={`h-9 w-20 text-left font-medium ${withTime ? "" : "pl-4"}`}>Side</th>
            <th className="h-9 text-left font-medium">Instrument</th>
            <th className="h-9 text-right font-medium">Qty</th>
            <th className="h-9 text-right font-medium">Avg price</th>
            <th className="h-9 pr-4 text-right font-medium">Value</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => {
            const ccy = r.currency as Ccy;
            return (
              <tr key={r.id} className="transition-colors hover:bg-muted/60 [&>td]:h-13">
                {withTime && <td className="num pl-4 text-muted-foreground">{timeOf(r.executedAt) ?? "-"}</td>}
                <td className={withTime ? "" : "pl-4"}>
                  <SideTag side={r.side} />
                </td>
                <td>
                  <Link href={`/symbol/${r.instrumentId}`} className="inline-flex hover:underline underline-offset-4">
                    <Ticker symbol={r.symbol} name={r.name} />
                  </Link>
                </td>
                <td className="num text-right">
                  {r.qty == null ? <span className="text-faint">-</span> : formatQty(r.qty)}
                  {r.fills > 1 && <span className="block text-[11px] text-faint">{r.fills} fills</span>}
                </td>
                <td className="num text-right">
                  <Money value={r.price} currency={ccy} decimals={2} />
                </td>
                <td className="num pr-4 text-right font-medium">
                  <Money value={r.valueNative} currency={ccy} decimals={2} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function SideTag({ side }: { side: "buy" | "sell" }) {
  return (
    <Tag tone={side} className="w-11 justify-center">
      {side === "buy" ? "Buy" : "Sell"}
    </Tag>
  );
}

function TradesSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true" aria-label="Loading trades">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-3 w-40" />
      </div>
      <Skeleton className="h-64 rounded-lg" />
      <Skeleton className="h-40 rounded-lg" />
    </div>
  );
}
