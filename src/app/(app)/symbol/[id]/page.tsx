import { PlusIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PriceChart } from "@/components/charts/price-chart";
import { Can } from "@/components/can";
import { BucketTag } from "@/components/chip";
import { ApproxMark } from "@/components/holding-badges";
import { Dash, Delta, formatAsOf, formatDate, formatMoney, formatQty, Money, Percent } from "@/components/money";
import { Panel, PanelHeader, Stat, Tag } from "@/components/panel";
import { Segmented } from "@/components/segmented";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getSymbolNews } from "@/lib/market/news";
import { getSymbolJournal, type SubjectRef } from "@/lib/views/journal";
import { getSymbolView, parseRange, RANGES, type RangeKey, type LotRowDto, type SymbolView } from "@/lib/views/symbol";
import { cn } from "@/lib/utils";
import { TargetEditor, TargetRowActions } from "../../targets/editor";
import { JournalComposer, JournalItem } from "./journal";
import { SectorEdit } from "./sector-edit";

// Range lives in the URL (?range=1m|6m|1y|5y|max), so a chart view is shareable.
const RANGE_LABEL: Record<RangeKey, string> = { "1m": "1M", "6m": "6M", "1y": "1Y", "5y": "5Y", max: "All" };

export default function SymbolPage({ params, searchParams }: PageProps<"/symbol/[id]">) {
  return (
    <Suspense fallback={<SymbolSkeleton />}>
      <Symbol params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Symbol({ params, searchParams }: Pick<PageProps<"/symbol/[id]">, "params" | "searchParams">) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const range = parseRange(sp.range);
  const data = await getSymbolView(id, range);
  if (!data) notFound();
  const { view: v, targets } = data;
  const inst = v.instrument;
  const ccy = inst.currency;
  const editorInstrument = { id: inst.id, symbol: inst.symbol, name: inst.name, exchange: inst.exchange, currency: ccy, price: v.quote?.price ?? null };
  const rangeHref = (r: RangeKey) => (r === "1y" ? `/symbol/${inst.id}` : `/symbol/${inst.id}?range=${r}`);
  const showTargets = v.targets.length > 0 || targets.canCreate || targets.history.length > 0;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-[-0.01em]">{inst.symbol}</h1>
          {inst.name.trim().toUpperCase() !== inst.symbol.toUpperCase() && <p className="truncate text-[13px] text-muted-foreground">{inst.name}</p>}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint">
            <span>
              {inst.exchange}
              {inst.sector && <> · {inst.sector}</>}
            </span>
            <Suspense fallback={null}>
              <Can action="manage">
                <SectorEdit id={inst.id} sector={inst.sector} />
              </Can>
            </Suspense>
          </div>
        </div>
        <Quote v={v} />
      </header>

      <Panel aria-labelledby="chart">
        <PanelHeader title="Price" id="chart">
          <Segmented
            label="Chart range"
            options={(Object.keys(RANGES) as RangeKey[]).map((r) => ({ label: RANGE_LABEL[r], href: rangeHref(r), active: r === range }))}
          />
        </PanelHeader>
        <ChartBlock v={v} />
      </Panel>

      {v.position && <PositionPanel v={v} />}

      {showTargets && (
        <Panel aria-labelledby="targets">
          <PanelHeader title="Targets" id="targets">
            {targets.history.length > 0 && (
              <Link href="/targets?tab=history" className="underline-offset-4 hover:text-foreground hover:underline">
                {targets.history.length} resolved
              </Link>
            )}
            {targets.canCreate && (
              <TargetEditor instrument={editorInstrument}>
                <Button variant="outline" className="min-h-10 text-[13px] md:min-h-8">
                  <PlusIcon aria-hidden />
                  New target
                </Button>
              </TargetEditor>
            )}
          </PanelHeader>
          <TargetsList rows={v.targets} instrument={editorInstrument} />
        </Panel>
      )}

      <Suspense fallback={<Skeleton className="h-40 rounded-lg" />}>
        <JournalSection instrumentId={inst.id} currency={ccy} review={typeof sp.review === "string" ? sp.review : undefined} />
      </Suspense>

      <Panel aria-labelledby="news">
        <PanelHeader title="News" id="news" />
        <Suspense fallback={<NewsSkeleton />}>
          <News symbol={inst.symbol} market={inst.market} name={inst.name} />
        </Suspense>
      </Panel>
    </div>
  );
}

function Quote({ v }: { v: SymbolView }) {
  const q = v.quote;
  if (!q) return <p className="text-[13px] text-faint">No price</p>;
  const asOf = q.source === "close" ? `Close ${formatDate(q.asOf.slice(0, 10))}` : formatAsOf(q.asOf);
  return (
    <div className="flex flex-col gap-1.5 sm:items-end">
      <p className="num text-[2rem] leading-none font-semibold tracking-[-0.03em]">
        {formatMoney(q.price, v.instrument.currency, { decimals: 2 })}
      </p>
      <p className="flex items-baseline gap-2 text-xs">
        {q.dayChangePct != null && <Delta value={q.dayChangePct} className="text-[13px] font-medium" />}
        <span className="text-faint">{asOf}</span>
      </p>
    </div>
  );
}

function ChartBlock({ v }: { v: SymbolView }) {
  const c = v.chart;
  const ccy = v.instrument.currency;
  if (c.points.length < 2) return <p className="px-4 py-16 text-center text-[13px] text-faint">No price history for this range</p>;
  return (
    <>
      <div className="px-3 pt-4 pb-3 sm:px-4">
        <PriceChart points={c.points} markers={c.markers} levels={c.levels} currency={ccy} />
      </div>
      <dl className="grid grid-cols-3 gap-4 border-t px-4 py-3">
        <Stat label={`${RANGE_LABEL[c.range]} change`}>
          <Delta value={c.changePct} />
        </Stat>
        <Stat label="High">{c.high ? <Money value={c.high.close} currency={ccy} decimals={2} /> : <Dash />}</Stat>
        <Stat label="Low">{c.low ? <Money value={c.low.close} currency={ccy} decimals={2} /> : <Dash />}</Stat>
      </dl>
      {c.adjustedFor.length > 0 && (
        <p className="border-t px-4 py-2.5 text-xs text-faint">
          Adjusted for{" "}
          {c.adjustedFor
            .map((a) => `${a.ratio >= 1 ? `${formatQty(a.ratio)}:1` : `1:${formatQty(1 / a.ratio)}`} on ${formatDate(a.exDate)}`)
            .join(", ")}
        </p>
      )}
      {c.markers.length > 0 && (
        // sr-only on a wrapper: a <table> sizes to its content and would widen the page on phones.
        <div className="sr-only">
          <table>
            <caption>Events on the chart, prices on today&apos;s share basis</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Event</th>
                <th scope="col">Price</th>
                {!v.amountsHidden && <th scope="col">Quantity</th>}
              </tr>
            </thead>
            <tbody>
              {c.markers.map((m, i) => (
                <tr key={i}>
                  <td>{formatDate(m.date)}</td>
                  <td>
                    {m.label}
                    {m.approximate ? " (approximate)" : ""}
                  </td>
                  <td>
                    <Money value={m.price} currency={ccy} decimals={2} />
                  </td>
                  {!v.amountsHidden && <td>{m.qty != null ? formatQty(m.qty) : ""}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function PositionPanel({ v }: { v: SymbolView }) {
  const p = v.position!;
  const ccy = v.instrument.currency;
  const hidden = v.amountsHidden;
  const price = v.quote?.price ?? null;
  // Amounts from the open lots (FIFO), like Holdings. Absent with amounts hidden.
  const invested = hidden ? null : p.lots.reduce((s, l) => s + (l.invested ?? 0), 0);
  const current = p.qty != null && price != null ? p.qty * price : null;
  const pnl = invested != null && current != null ? current - invested : null;
  const since = p.lots.map((l) => l.openDate).sort()[0];
  const differs = p.brokerAvg != null && Math.abs(p.brokerAvg - p.avgCost) / p.avgCost > 0.0005;

  return (
    <Panel aria-labelledby="position">
      <PanelHeader title="Position" id="position">
        {p.buckets.map((b) => (
          <BucketTag key={b.id} {...b} />
        ))}
      </PanelHeader>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 px-4 py-4 sm:grid-cols-3 lg:grid-cols-6">
        {!hidden && <Stat label="Qty">{formatQty(p.qty ?? 0)}</Stat>}
        <Stat label="Avg cost">
          <Money value={p.avgCost} currency={ccy} decimals={2} />
          {differs && (
            <span className="block text-xs font-normal text-faint" title="Broker weighted average; differs from FIFO after a partial sale">
              Broker <Money value={p.brokerAvg} currency={ccy} decimals={2} />
            </span>
          )}
        </Stat>
        {!hidden && (
          <>
            <Stat label="Invested">
              <Money value={invested} currency={ccy} />
            </Stat>
            <Stat label="Current">
              <Money value={current} currency={ccy} />
            </Stat>
          </>
        )}
        <Stat label="P&L">
          {hidden ? (
            <Delta value={p.returnPct} />
          ) : (
            <span className="flex flex-col">
              <Delta value={pnl} kind="money" currency={ccy} />
              <Delta value={p.returnPct} className="text-xs font-normal" />
            </span>
          )}
        </Stat>
        <Stat label="Held since">{since ? formatDate(since) : <Dash />}</Stat>
      </dl>
      <Lots lots={p.lots} ccy={ccy} hidden={hidden} market={v.instrument.market} />
    </Panel>
  );
}

function LongTerm({ l, market }: { l: LotRowDto; market: "IN" | "US" }) {
  if (l.longTerm) return <Tag title={`Long-term since ${formatDate(l.ltcgDate)} (held over ${market === "IN" ? 12 : 24} months)`}>LTCG</Tag>;
  return (
    <span className="whitespace-nowrap text-muted-foreground" title={`Long-term from ${formatDate(l.ltcgDate)}`}>
      in {l.daysToLtcg}d
    </span>
  );
}

function Lots({ lots, ccy, hidden, market }: { lots: LotRowDto[]; ccy: "INR" | "USD"; hidden: boolean; market: "IN" | "US" }) {
  const head = "h-9 px-3 text-xs font-medium whitespace-nowrap text-muted-foreground first:pl-4 last:pr-4";
  const cell = "h-11 px-3 first:pl-4 last:pr-4";
  const r = "num text-right whitespace-nowrap";
  const acquired = (l: LotRowDto) => (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      {formatDate(l.openDate)}
      {l.approximate && <ApproxMark />}
      {l.bonus && <Tag>Bonus</Tag>}
    </span>
  );
  return (
    <div className="border-t">
      <h3 className="sr-only">Open lots</h3>
      <ul className="divide-y md:hidden">
        {lots.map((l) => (
          <li key={l.eventId} className="flex items-center justify-between gap-4 px-4 py-2.5 text-[13px]">
            <span className="flex min-w-0 flex-col">
              {acquired(l)}
              <span className="num text-xs text-faint">
                {hidden ? (
                  <>
                    <Percent value={l.sharePct} decimals={0} /> of position
                  </>
                ) : (
                  <>
                    {formatQty(l.qty ?? 0)} × <Money value={l.costPerShare} currency={ccy} decimals={2} />
                  </>
                )}
              </span>
            </span>
            <span className="flex shrink-0 flex-col items-end text-xs">
              {l.returnPct == null ? <Dash label="No cost" /> : <Delta value={l.returnPct} className="text-[13px]" />}
              <LongTerm l={l} market={market} />
            </span>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-[13px]">
          <caption className="sr-only">Open lots{hidden ? ", quantities and costs hidden" : ""}</caption>
          <thead className="border-b text-left">
            <tr>
              <th scope="col" className={head}>
                Lot
              </th>
              {hidden ? (
                <th scope="col" className={cn(head, "text-right")}>
                  Share
                </th>
              ) : (
                <>
                  <th scope="col" className={cn(head, "text-right")}>
                    Qty
                  </th>
                  <th scope="col" className={cn(head, "text-right")}>
                    Cost
                  </th>
                  <th scope="col" className={cn(head, "text-right")}>
                    Invested
                  </th>
                </>
              )}
              <th scope="col" className={cn(head, "text-right")}>
                Return
              </th>
              <th scope="col" className={cn(head, "text-right")}>
                Long-term
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {lots.map((l) => (
              <tr key={l.eventId}>
                <td className={cn(cell, "w-full")}>{acquired(l)}</td>
                {hidden ? (
                  <td className={cn(cell, r)}>
                    <Percent value={l.sharePct} decimals={0} />
                  </td>
                ) : (
                  <>
                    <td className={cn(cell, r)}>{formatQty(l.qty ?? 0)}</td>
                    <td className={cn(cell, r)}>
                      <Money value={l.costPerShare} currency={ccy} decimals={2} />
                    </td>
                    <td className={cn(cell, r)}>
                      <Money value={l.invested} currency={ccy} />
                    </td>
                  </>
                )}
                <td className={cn(cell, r)}>{l.returnPct == null ? <Dash label="No cost" /> : <Delta value={l.returnPct} />}</td>
                <td className={cn(cell, "text-right")}>
                  <LongTerm l={l} market={market} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type EditorInstrument = { id: string; symbol: string; name: string; exchange: string; currency: "INR" | "USD"; price: number | null };

function TargetsList({ rows, instrument }: { rows: SymbolView["targets"]; instrument: EditorInstrument }) {
  if (!rows.length) return <p className="px-4 py-4 text-[13px] text-faint">No open targets</p>;
  return (
    <ul className="divide-y">
      {rows.map((r) => (
        <li key={r.id} className="flex min-h-13 items-center gap-3 px-4 py-2 text-[13px]">
          <Tag className="w-12 justify-center">{r.kind === "target" ? "Target" : "Stop"}</Tag>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex flex-wrap items-baseline gap-x-2">
              <Money value={r.price} currency={r.currency} decimals={2} className="font-medium" />
              {r.distancePct != null && <Delta value={r.distancePct} decimals={1} className="text-xs" />}
              {r.setPrice != null && (
                <span className="text-xs text-faint">
                  set at <Money value={r.setPrice} currency={r.currency} decimals={2} /> pre-split
                </span>
              )}
            </span>
            <span className="truncate text-xs text-faint">
              {r.setBy}, {formatDate(r.setOn)}
              {r.deadline ? ` · by ${formatDate(r.deadline)}` : ""}
              {r.note ? ` · ${r.note}` : ""}
            </span>
          </span>
          {r.canEdit && (
            <TargetRowActions
              instrument={instrument}
              target={{ id: r.id, kind: r.kind, price: r.price, inputMode: r.inputMode, pctValue: r.pctValue, deadline: r.deadline, note: r.note }}
              label={`${r.symbol} ${r.kind}`}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

const TARGET_STATUS = { pending: "open", hit: "hit", stopped: "stopped", expired: "expired", cancelled: "cancelled" } as const;

function subjectLabel(s: SubjectRef, ccy: "INR" | "USD") {
  const money = (v: number) => formatMoney(v, ccy, { decimals: 2 });
  if (s.type === "buy_event")
    return `${s.event === "buy" ? `Buy on ${formatDate(s.date)} at ${money(s.price)}` : `Opening position, ${formatDate(s.date)}`}${s.live ? "" : " (replaced)"}`;
  if (s.type === "watch_item") return `Watchlist, added ${formatDate(s.date)}${s.archived ? " (archived)" : ""}`;
  return `${s.kind === "target" ? "Target" : "Stop"} ${money(s.price)} (${TARGET_STATUS[s.status]})`;
}

/**
 * Timeline (newest first) plus a composer for actors who may write. `review` = a target id from Due for review.
 * Nothing at all for share-link viewers.
 */
async function JournalSection({ instrumentId, currency, review }: { instrumentId: string; currency: "INR" | "USD"; review?: string }) {
  const j = await getSymbolJournal(instrumentId, currency);
  if (!j.visible) return null;
  const options = j.options.map((s) => ({ value: `${s.type}:${s.id}`, label: subjectLabel(s, currency) }));
  const reviewing = review && options.some((o) => o.value === `target:${review}`) ? `target:${review}` : undefined;
  return (
    <Panel aria-labelledby="journal" className="scroll-mt-20">
      <PanelHeader title="Journal" id="journal">
        {j.entries.length > 0 && <span className="num">{j.entries.length}</span>}
      </PanelHeader>
      {j.canWrite &&
        (options.length ? (
          <details open={!!reviewing} className="group/new border-b">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 text-[13px] text-muted-foreground transition-colors hover:text-foreground focus-visible:bg-muted/60 focus-visible:outline-none group-open/new:text-foreground [&::-webkit-details-marker]:hidden">
              <PlusIcon className="size-3.5 transition-transform group-open/new:rotate-45" aria-hidden />
              New entry
            </summary>
            <div className="px-4 pb-4">
              <JournalComposer
                key={reviewing ?? "new"}
                options={options}
                defaultSubject={reviewing}
                defaultKind={reviewing ? "review" : "thesis"}
                autoFocus={!!reviewing}
              />
            </div>
          </details>
        ) : (
          <p className="border-b px-4 py-3 text-[13px] text-faint">Watch it or set a target to start a journal</p>
        ))}
      {j.entries.length ? (
        <div className="divide-y">
          {j.entries.map((e) => (
            <JournalItem key={e.id} entry={e} subjectLabel={e.subject ? subjectLabel(e.subject, currency) : undefined} />
          ))}
        </div>
      ) : (
        <p className="px-4 py-4 text-[13px] text-faint">No entries yet</p>
      )}
    </Panel>
  );
}

const newsTime = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

async function News({ symbol, market, name }: { symbol: string; market: "IN" | "US"; name: string }) {
  const items = await getSymbolNews(symbol, market, name).catch(() => null);
  if (!items) return <p className="px-4 py-4 text-[13px] text-faint">News unavailable</p>;
  if (!items.length) return <p className="px-4 py-4 text-[13px] text-faint">No headlines this week</p>;
  return (
    <ul className="divide-y">
      {items.map((n) => (
        <li key={n.link}>
          <a
            href={n.link}
            target="_blank"
            rel="noopener noreferrer"
            className="group/n flex flex-col gap-0.5 px-4 py-3 transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
          >
            <span className="text-[13px] font-medium group-hover/n:underline group-hover/n:underline-offset-4">{n.title}</span>
            <span className="text-xs text-faint">
              {n.publisher ?? "Unknown source"}
              {n.pubDate && <> · {newsTime(n.pubDate)}</>}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function NewsSkeleton() {
  return (
    <div className="flex flex-col gap-4 px-4 py-4" aria-busy="true" aria-label="Loading news">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-3 w-40" />
        </div>
      ))}
    </div>
  );
}

function SymbolSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true" aria-label="Loading symbol">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-56" />
        </div>
        <Skeleton className="h-10 w-40" />
      </div>
      <Skeleton className="h-96 rounded-lg" />
      <Skeleton className="h-40 rounded-lg" />
    </div>
  );
}
