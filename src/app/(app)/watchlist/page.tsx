import { EyeIcon } from "lucide-react";
import Link from "next/link";
import { type ReactNode, Suspense } from "react";
import { Chip } from "@/components/chip";
import { EmptyState } from "@/components/empty-state";
import { Delta, formatAsOf, formatDate, Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Tag, Ticker } from "@/components/panel";
import { Segmented } from "@/components/segmented";
import { type Column, DataTable, type SortDir } from "@/components/tables/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { can, requireActor } from "@/lib/auth/access";
import { getWatchJournal } from "@/lib/views/journal";
import { getWatchlistView, type WatchlistView, type WatchRow } from "@/lib/views/watchlist";
import { AddDialog, RowMenu } from "./controls";

// Table state lives in the URL (?view=archived&tag=<name>&sort=<key>&dir=asc|desc): shareable,
// survives reload, no client JS. Defaults are omitted from links.
type State = { view: "active" | "archived"; tag: string | null; sort: string; dir: SortDir };
const DEFAULT: State = { view: "active", tag: null, sort: "added", dir: "desc" };

type Row = WatchRow;

const SORTS: Record<string, (r: Row) => number | string | null> = {
  symbol: (r) => r.symbol,
  added: (r) => r.addedOn,
  return: (r) => r.returnPct,
  day: (r) => r.dayChangePct,
};

function parse(sp: Record<string, string | string[] | undefined>): State {
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const sort = one("sort");
  return {
    view: one("view") === "archived" ? "archived" : "active",
    tag: one("tag")?.toLowerCase() || null,
    sort: sort && sort in SORTS ? sort : DEFAULT.sort,
    dir: one("dir") === "asc" ? "asc" : "desc",
  };
}

function href(s: State) {
  const q = new URLSearchParams();
  if (s.view !== DEFAULT.view) q.set("view", s.view);
  if (s.tag) q.set("tag", s.tag);
  if (s.sort !== DEFAULT.sort) q.set("sort", s.sort);
  if (s.dir !== DEFAULT.dir) q.set("dir", s.dir);
  const qs = q.toString();
  return qs ? `/watchlist?${qs}` : "/watchlist";
}

export default function WatchlistPage({ searchParams }: PageProps<"/watchlist">) {
  return (
    <Suspense fallback={<WatchlistSkeleton />}>
      <Watchlist searchParams={searchParams} />
    </Suspense>
  );
}

async function Watchlist({ searchParams }: { searchParams: PageProps<"/watchlist">["searchParams"] }) {
  const [actor, view, sp] = await Promise.all([requireActor(), getWatchlistView(), searchParams]);
  const canSet = can(actor, "suggest"); // targets: create → suggest (src/lib/targets/actions.ts)
  const s = parse(sp);
  const archived = s.view === "archived";
  const journal = await getWatchJournal(view.rows.map((r) => r.id));

  const key = SORTS[s.sort];
  const rows: Row[] = view.rows
    .filter((r) => r.archived === archived && (!s.tag || r.tags.includes(s.tag)))
    .sort((a, b) => {
      const x = key(a);
      const y = key(b);
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1; // missing last
      const c = typeof x === "string" ? x.localeCompare(y as string) : x - (y as number);
      return s.dir === "asc" ? c : -c;
    });

  const menu = (r: Row) => (
    <RowMenu
      id={r.id}
      symbol={r.symbol}
      item={r.canEdit ? { id: r.id, symbol: r.symbol, priceAtAdd: r.priceAtAdd, note: r.note, tags: r.tags } : null}
      instrument={
        canSet && !archived
          ? { id: r.instrumentId, symbol: r.symbol, name: r.name, exchange: r.exchange, currency: r.currency, price: r.price }
          : null
      }
      buckets={archived ? [] : view.buckets.map((b) => ({ ...b, member: r.buckets.some((m) => m.id === b.id) }))}
      journalHref={journal.canWrite || journal.byItem.get(r.id)?.length ? `/symbol/${r.instrumentId}#journal` : null}
    />
  );

  const header = (
    <PageHeader
      title="Watchlist"
      meta={view.priceAsOf ? `As of ${formatAsOf(view.priceAsOf)}` : undefined}
      actions={view.canAdd && <AddDialog />}
    />
  );

  if (view.rows.length === 0)
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState icon={EyeIcon} title="Nothing on the watchlist" className="flex-row items-center gap-3 py-6" />
      </div>
    );

  const columns: Column<Row>[] = [
    { key: "symbol", header: "Instrument", sortable: true, firstDir: "asc", mobileSort: true, cell: (r) => <Instrument r={r} /> },
    { key: "added", header: "Added", sortable: true, mobileSort: true, cell: (r) => <span className="num whitespace-nowrap text-faint">{formatDate(r.addedOn)}</span> },
    { key: "atAdd", header: "Price at add", align: "right", cell: (r) => <Money value={r.priceAtAdd} currency={r.currency} decimals={2} /> },
    { key: "price", header: "LTP", align: "right", cell: (r) => <Money value={r.price} currency={r.currency} decimals={2} className="font-medium" /> },
    { key: "return", header: "Since add", align: "right", sortable: true, mobileSort: true, cell: (r) => <Delta value={r.returnPct} /> },
    { key: "day", header: "Day", align: "right", sortable: true, cell: (r) => <Delta value={r.dayChangePct} /> },
    { key: "tags", header: "Tags", cell: (r) => <Tags tags={r.tags} /> },
    { key: "actions", header: "", className: "w-12", cell: menu },
  ];

  return (
    <div className="flex flex-col gap-6">
      {header}

      {(view.tags.length > 0 || view.counts.archived > 0) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {view.tags.length > 0 && !archived ? (
            <nav aria-label="Filter by tag" className="flex flex-wrap items-center gap-1.5">
              <Chip href={href({ ...s, tag: null })} active={!s.tag}>
                All
              </Chip>
              {view.tags.map((t) => (
                <Chip key={t.name} href={href({ ...s, tag: s.tag === t.name ? null : t.name })} active={s.tag === t.name}>
                  {t.name} <span className="num text-faint">{t.count}</span>
                </Chip>
              ))}
            </nav>
          ) : (
            <span />
          )}
          {view.counts.archived > 0 && <ViewToggle view={view} s={s} />}
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState icon={EyeIcon} title={archived ? "Nothing archived" : `Nothing tagged ${s.tag ?? ""}`.trim()} className="flex-row items-center gap-3 py-6" />
      ) : (
        <DataTable
          caption="Watchlist"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          sort={{ key: s.sort, dir: s.dir }}
          hrefFor={(k, d) => href({ ...s, sort: k, dir: d })}
          mobileRow={(r) => <MobileRow r={r} menu={menu(r)} />}
        />
      )}
    </div>
  );
}

function ViewToggle({ view, s }: { view: WatchlistView; s: State }) {
  return (
    <Segmented
      label="Show"
      options={[
        { label: `Active ${view.counts.active}`, href: href({ ...s, view: "active", tag: null }), active: s.view === "active" },
        { label: `Archived ${view.counts.archived}`, href: href({ ...s, view: "archived", tag: null }), active: s.view === "archived" },
      ]}
    />
  );
}

function Instrument({ r }: { r: WatchRow }) {
  return (
    <Link href={`/symbol/${r.instrumentId}`} className="block w-fit max-w-64 rounded-sm underline-offset-4 hover:[&>span>span:first-child]:underline">
      <Ticker symbol={r.symbol} name={r.name} />
    </Link>
  );
}

function Tags({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <Tag key={t}>{t}</Tag>
      ))}
    </span>
  );
}

function MobileRow({ r, menu }: { r: Row; menu: ReactNode }) {
  return (
    <div className="flex items-center gap-1 py-3 pr-1 pl-4">
      <Link href={`/symbol/${r.instrumentId}`} className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className="text-[13px] font-semibold tracking-[0.01em]">{r.symbol}</span>
          <span className="flex items-baseline gap-2 text-[13px]">
            <Money value={r.price} currency={r.currency} decimals={2} className="font-medium" />
            {r.dayChangePct != null && <Delta value={r.dayChangePct} className="text-xs" />}
          </span>
        </span>
        <span className="flex items-baseline justify-between gap-3 text-xs">
          <span className="truncate text-faint">
            Since {formatDate(r.addedOn)}
            {r.tags.length > 0 && `, ${r.tags.join(", ")}`}
          </span>
          <Delta value={r.returnPct} />
        </span>
      </Link>
      {menu}
    </div>
  );
}

function WatchlistSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading watchlist">
      <div className="flex items-end justify-between">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-8 w-16" />
      </div>
      <Skeleton className="h-7 w-64" />
      <div className="flex flex-col gap-px overflow-hidden rounded-lg border">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-13 rounded-none" />
        ))}
      </div>
    </div>
  );
}
