import Link from "next/link";
import { Suspense } from "react";
import { ExportMenu } from "@/components/export-menu";
import { type Ccy, formatAsOf, formatDate, formatQty, Money } from "@/components/money";
import { PageSkeleton } from "@/components/page-skeleton";
import { Panel, Tag } from "@/components/panel";
import { SOURCE } from "@/components/source-badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getLedgerView, type LedgerView } from "@/lib/views/ledger";
import type { TradeSource } from "@/lib/views/trades";
import { OwnerOnly, SectionHeader } from "../owner-only";
import { CorrectForm, ReclassifyForm, ResolveButtons } from "./forms";

export default function LedgerPage({ searchParams }: PageProps<"/settings/ledger">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Ledger searchParams={searchParams} />
    </Suspense>
  );
}

async function Ledger({ searchParams }: { searchParams: PageProps<"/settings/ledger">["searchParams"] }) {
  const sp = await searchParams;
  const v = await getLedgerView(typeof sp.instrument === "string" ? sp.instrument : undefined);
  if (!v) return <OwnerOnly />;

  return (
    <div className="flex flex-col gap-6">
      <ReviewQueue v={v} />
      <Events v={v} />
    </div>
  );
}

/** Provenance: where an entry came from. Dashed for derived sources (estimated, opening). */
function SourceTag({ source }: { source: TradeSource }) {
  const s = SOURCE[source];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Tag tabIndex={0} aria-label={`${s.label}. ${s.help}`} className={cn("cursor-help", (source === "inferred" || source === "opening") && "border-dashed")}>
          {s.label}
        </Tag>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{s.help}</TooltipContent>
    </Tooltip>
  );
}

const Muted = ({ children }: { children: React.ReactNode }) => <p className="px-4 py-6 text-[13px] text-muted-foreground">{children}</p>;

function ReviewQueue({ v }: { v: LedgerView }) {
  return (
    <Panel aria-labelledby="review">
      <SectionHeader id="review" title="Needs review" className={cn(v.items.length === 0 && "border-b-0")}>
        {v.items.length > 0 ? (
          <span className="num text-xs text-muted-foreground">{v.items.length} open</span>
        ) : (
          <span className="text-xs text-faint">Nothing open</span>
        )}
      </SectionHeader>
      {v.items.length > 0 && (
        <ul className="divide-y">
          {v.items.map((it) => (
            <li key={it.id} className="flex flex-col gap-3 px-4 py-3.5 md:flex-row md:items-center md:justify-between md:gap-6">
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                  <Link
                    href={`/settings/ledger?instrument=${it.instrumentId}#events`}
                    className="font-semibold tracking-[0.01em] underline-offset-4 hover:underline"
                  >
                    {it.symbol}
                  </Link>
                  <Tag tone="brand">{it.label}</Tag>
                  <span className="text-xs text-faint">since {formatAsOf(it.createdAt)}</span>
                </div>
                <p className="text-[13px] text-muted-foreground">{it.message}</p>
                {it.event && (
                  <p className="text-xs text-muted-foreground">
                    <span className="capitalize">{it.event.type}</span> on {formatDate(it.event.date)} at{" "}
                    <Money value={it.event.price} currency={it.event.currency as Ccy} decimals={2} className="text-foreground" />
                    {it.event.source !== it.event.type && <>, {SOURCE[it.event.source].label.toLowerCase()}</>}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1">
                {it.event && <CorrectForm event={it.event} />}
                <ResolveButtons itemId={it.id} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

const th = "h-9 px-4 text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "h-12 px-4 whitespace-nowrap";
const sticky = "max-md:sticky max-md:left-0 max-md:z-10 max-md:bg-card";

function Events({ v }: { v: LedgerView }) {
  const sel = v.selected;
  return (
    <Panel aria-labelledby="events">
      <SectionHeader id="events" title="Entries" description="Every entry for one instrument, replaced ones included, newest first">
        {/* Plain GET form: the choice lands in the URL, no client JS. */}
        <form action="/settings/ledger" className="flex flex-1 items-center gap-2 sm:flex-none">
          <label htmlFor="instrument" className="sr-only">
            Instrument
          </label>
          <select
            id="instrument"
            name="instrument"
            defaultValue={sel?.id ?? ""}
            className="h-10 min-w-0 flex-1 rounded-md sm:min-w-44 border bg-card px-2 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:h-8"
          >
            <option value="" disabled>
              Choose instrument
            </option>
            {v.instruments.map((i) => (
              <option key={i.id} value={i.id}>
                {i.symbol} ({i.market === "US" ? "US" : "India"})
              </option>
            ))}
          </select>
          <Button type="submit" variant="outline" className="min-h-10 md:min-h-8">
            Show
          </Button>
        </form>
        {/* Below the owner gate above: the export itself also answers 403 to anyone else. */}
        <ExportMenu kind="ledger" />
      </SectionHeader>

      {!sel ? (
        <Muted>Choose an instrument to see its entries.</Muted>
      ) : v.events.length === 0 ? (
        <Muted>No entries for {sel.symbol}.</Muted>
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full text-[13px]" aria-label={`${sel.symbol} entries`}>
            <thead className="border-b">
              <tr>
                <th scope="col" className={cn(th, sticky, "text-left")}>
                  Date
                </th>
                <th scope="col" className={cn(th, "text-left")}>
                  Type
                </th>
                <th scope="col" className={cn(th, "text-right")}>
                  Quantity
                </th>
                <th scope="col" className={cn(th, "text-right")}>
                  Price
                </th>
                <th scope="col" className={cn(th, "text-right")}>
                  Amount
                </th>
                <th scope="col" className={cn(th, "text-left")}>
                  Source
                </th>
                <th scope="col" className={th}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {v.events.map((e) => {
                const c = v.correctable[e.id];
                const action = e.type === "split" || e.type === "bonus";
                return (
                  <tr key={e.id} className={cn("hover:bg-muted/60", e.superseded && "text-muted-foreground")}>
                    <td className={cn(td, sticky, "num")}>{formatDate(e.date)}</td>
                    <td className={td}>
                      <span className={cn("capitalize", e.superseded && "line-through")}>{e.type}</span>
                      {action && (
                        <span className="ml-2 text-xs text-faint">ex-date {e.exDate ? formatDate(e.exDate) : "unknown"}</span>
                      )}
                    </td>
                    <td className={cn(td, "num text-right")}>{formatQty(e.qty)}</td>
                    <td className={cn(td, "num text-right")}>
                      {action ? (
                        e.ratio
                      ) : (
                        <>
                          {e.approximate && (
                            <span className="mr-1 text-faint" title="Estimated" aria-label="Estimated">
                              ≈
                            </span>
                          )}
                          <Money value={e.price} currency={e.currency as Ccy} decimals={2} />
                        </>
                      )}
                    </td>
                    <td className={cn(td, "text-right")}>
                      <Money value={e.amountInr} />
                    </td>
                    <td className={td}>
                      <div className="flex items-center gap-2">
                        <SourceTag source={e.source} />
                        {e.superseded && (
                          <span className="text-xs text-faint">replaced by {e.replacedBy.map((x) => SOURCE[x].label.toLowerCase()).join(" and ")}</span>
                        )}
                      </div>
                    </td>
                    <td className={cn(td, "text-right")}>
                      {!e.superseded && (c || e.type === "split") && (
                        <div className="flex justify-end gap-1">
                          {c && <CorrectForm event={c} />}
                          {e.type === "split" && e.exDate && <ReclassifyForm instrumentId={e.instrumentId} exDate={e.exDate} />}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
