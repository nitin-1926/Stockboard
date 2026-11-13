"use client";

import {
  ArchiveIcon,
  CheckIcon,
  ClipboardPasteIcon,
  LayersIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  NotebookPenIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TargetIcon,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useActionState, useId, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { BucketSwatch } from "@/components/chip";
import { Tag } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { SearchHit } from "@/lib/market/search";
import { cn } from "@/lib/utils";
import type { BucketChip } from "@/lib/views/buckets";
import type { InstrumentOption } from "@/lib/views/targets";
import { addMemberAction } from "../buckets/actions";
import { TargetEditor } from "../targets/editor";
import { addAction, archiveAction, pasteAction, searchAction, updateAction } from "./actions";

// Client islands for the watchlist. Rendered only for actors allowed to use them; each
// server action re-checks the actor anyway.

const TEXTAREA =
  "min-h-24 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

function Submit({ children }: { children: ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending}>
      {pending && <Loader2Icon className="animate-spin motion-reduce:animate-none" aria-hidden />}
      {children}
    </Button>
  );
}

const MARKETS = [
  { key: "IN", label: "India" },
  { key: "US", label: "US" },
] as const;

/** Search-as-you-type combobox (ARIA 1.2 pattern); results grouped by market. */
export function AddSymbol() {
  const id = useId();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [active, setActive] = useState(-1);
  const [searching, setSearching] = useState(false);
  const [status, setStatus] = useState<{ error: boolean; text: string } | null>(null);
  const [adding, startAdd] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const seq = useRef(0);

  // Ordered as rendered (India group, then US), so arrow keys walk the visible order.
  const ordered = hits ? MARKETS.flatMap((m) => hits.filter((h) => h.market === m.key)) : [];
  const open = q.trim().length > 0 && hits !== null;

  function search(v: string) {
    setQ(v);
    setActive(-1);
    clearTimeout(timer.current);
    if (!v.trim()) {
      setHits(null);
      return;
    }
    timer.current = setTimeout(async () => {
      const mine = ++seq.current;
      setSearching(true);
      const r = await searchAction(v);
      if (mine !== seq.current) return; // a newer keystroke owns the list
      setSearching(false);
      if ("error" in r) {
        setHits([]);
        setStatus({ error: true, text: r.error });
      } else setHits(r);
    }, 250);
  }

  function pick(h: SearchHit) {
    startAdd(async () => {
      const r = await addAction(h.symbol);
      if ("error" in r) setStatus({ error: true, text: r.error });
      else {
        setStatus({ error: false, text: r.created ? `Added ${r.symbol}.` : `${r.symbol} is already on the watchlist.` });
        setQ("");
        setHits(null);
      }
    });
  }

  return (
    <div className="flex w-full flex-col gap-1">
      <Label htmlFor={`${id}-input`} className="sr-only">
        Add a symbol
      </Label>
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          id={`${id}-input`}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${id}-opt-${active}` : undefined}
          aria-describedby={`${id}-status`}
          autoComplete="off"
          spellCheck={false}
          placeholder="TCS, AAPL, Nifty BeES"
          value={q}
          disabled={adding}
          onChange={(e) => search(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && ordered.length) {
              e.preventDefault();
              setActive((a) => (a + 1) % ordered.length);
            } else if (e.key === "ArrowUp" && ordered.length) {
              e.preventDefault();
              setActive((a) => (a <= 0 ? ordered.length - 1 : a - 1));
            } else if (e.key === "Enter" && ordered[active >= 0 ? active : 0]) {
              e.preventDefault();
              pick(ordered[active >= 0 ? active : 0]);
            } else if (e.key === "Escape") {
              setHits(null);
              setActive(-1);
            }
          }}
          className="h-10 pr-9 pl-8 md:h-9"
        />
        {(searching || adding) && (
          <Loader2Icon
            className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 animate-spin text-muted-foreground motion-reduce:animate-none"
            aria-hidden
          />
        )}
      </div>

      <div
        id={`${id}-list`}
        role="listbox"
        aria-label="Matching symbols"
        hidden={!open}
        className="-mx-1 max-h-72 overflow-y-auto"
      >
        {open && ordered.length === 0 && !searching && (
          <p className="px-2.5 py-3 text-[13px] text-muted-foreground">No NSE, BSE or US match.</p>
        )}
        {MARKETS.map((m) => {
          const group = ordered.filter((h) => h.market === m.key);
          if (!group.length) return null;
          return (
            <div key={m.key} role="group" aria-labelledby={`${id}-g-${m.key}`}>
              <div id={`${id}-g-${m.key}`} className="px-2.5 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                {m.label}
              </div>
              {group.map((h) => {
                const i = ordered.indexOf(h);
                return (
                  <div
                    key={h.symbol}
                    id={`${id}-opt-${i}`}
                    role="option"
                    aria-selected={i === active}
                    onMouseDown={(e) => e.preventDefault()} // keep focus in the input
                    onClick={() => pick(h)}
                    onMouseEnter={() => setActive(i)}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-[13px]",
                      i === active && "bg-muted",
                    )}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="font-semibold tracking-[0.01em]">{h.symbol.replace(/\.(NS|BO)$/, "")}</span>
                      <span className="truncate text-xs text-muted-foreground">{h.name}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                      {h.type === "etf" && <Tag>ETF</Tag>}
                      <span>{h.exchange}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <p id={`${id}-status`} role="status" className={cn("min-h-4 text-xs", status?.error ? "text-destructive" : "text-muted-foreground")}>
        {status?.text}
      </p>
    </div>
  );
}

function SymbolList({ title, items, tone }: { title: string; items: string[]; tone?: "muted" | "warn" }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-sm font-medium">
        {title} <span className="font-mono text-muted-foreground tabular-nums">{items.length}</span>
      </h3>
      {items.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {items.map((s) => (
            <li key={s}>
              <Tag className={cn("font-mono", tone === "warn" && "border-dashed")}>{s}</Tag>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PasteForm() {
  const [state, action] = useActionState(pasteAction, null);
  if (state && !("error" in state))
    return (
      <div className="flex flex-col gap-4" role="status">
        <SymbolList title="Added" items={state.added} />
        <SymbolList title="Already watching" items={state.existing} />
        <SymbolList title="Not found" items={state.unresolved} tone="warn" />
      </div>
    );
  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="paste-symbols">Symbols</Label>
        <textarea
          id="paste-symbols"
          name="symbols"
          required
          rows={5}
          spellCheck={false}
          placeholder={"TCS, INFY\nHDFCBANK"}
          className={TEXTAREA}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="paste-market">Market</Label>
        <Select name="market" defaultValue="auto">
          <SelectTrigger id="paste-market" className="h-9 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Auto</SelectItem>
            <SelectItem value="IN">India (NSE, BSE)</SelectItem>
            <SelectItem value="US">US</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {state && "error" in state && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <DialogFooter>
        <Submit>Import</Submit>
      </DialogFooter>
    </form>
  );
}

/** Header "Add": symbol search, with a paste-a-list mode for bulk imports. */
export function AddDialog() {
  const [paste, setPaste] = useState(false);
  return (
    <Dialog onOpenChange={(o) => !o && setPaste(false)}>
      <DialogTrigger asChild>
        <Button className="h-10 md:h-8">
          <PlusIcon aria-hidden />
          Add
        </Button>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{paste ? "Paste a list" : "Add to watchlist"}</DialogTitle>
        </DialogHeader>
        {/* A fresh form (and result) every time paste mode opens. */}
        {paste ? <PasteForm /> : <AddSymbol />}
        <button
          type="button"
          onClick={() => setPaste((p) => !p)}
          className="inline-flex min-h-10 w-fit items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline md:min-h-0"
        >
          {paste ? <SearchIcon className="size-3.5" aria-hidden /> : <ClipboardPasteIcon className="size-3.5" aria-hidden />}
          {paste ? "Search instead" : "Paste a list of tickers"}
        </button>
      </DialogContent>
    </Dialog>
  );
}

export type EditableItem = { id: string; symbol: string; priceAtAdd: number | null; note: string | null; tags: string[] };

function EditForm({ item, done }: { item: EditableItem; done: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      action={async (fd) => {
        const r = await updateAction(null, fd);
        if (r && "error" in r) setError(r.error);
        else done();
      }}
      className="flex flex-col gap-4"
    >
      <input type="hidden" name="id" value={item.id} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="edit-price">Price at add</Label>
        <Input id="edit-price" name="priceAtAdd" inputMode="decimal" defaultValue={item.priceAtAdd ?? ""} className="h-9 font-mono" />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="edit-tags">Tags</Label>
        <Input id="edit-tags" name="tags" defaultValue={item.tags.join(", ")} placeholder="Comma separated" className="h-9" />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="edit-note">Note</Label>
        <textarea id="edit-note" name="note" rows={3} maxLength={500} defaultValue={item.note ?? ""} className={TEXTAREA} />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Submit>Save</Submit>
      </DialogFooter>
    </form>
  );
}

/**
 * One menu per row for everything that used to be inline chips: edit/archive (`item`, when the
 * actor may edit), set a target (`instrument`, when they may), add to a bucket, open the journal.
 */
export function RowMenu({
  id,
  symbol,
  item,
  instrument,
  buckets,
  journalHref,
}: {
  id: string;
  symbol: string;
  item: EditableItem | null;
  instrument: InstrumentOption | null;
  buckets: (BucketChip & { member: boolean })[];
  journalHref: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const [targeting, setTargeting] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const addable = buckets.some((b) => !b.member);
  if (!item && !instrument && !addable && !journalHref) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-10 text-muted-foreground md:size-8"
            aria-label={`Actions for ${symbol}`}
            title={error ?? undefined}
            disabled={pending}
          >
            {pending ? <Loader2Icon className="animate-spin motion-reduce:animate-none" aria-hidden /> : <MoreHorizontalIcon aria-hidden />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {instrument && (
            <DropdownMenuItem onSelect={() => setTargeting(true)}>
              <TargetIcon aria-hidden />
              Set target
            </DropdownMenuItem>
          )}
          {addable && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <LayersIcon aria-hidden />
                Add to bucket
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                {buckets.map((b) => (
                  <DropdownMenuItem
                    key={b.id}
                    disabled={b.member}
                    onSelect={() =>
                      start(async () => {
                        const r = await addMemberAction(b.id, { watchItemId: id });
                        setError("error" in r ? r.error : null);
                      })
                    }
                  >
                    <BucketSwatch color={b.color} />
                    <span className="truncate">{b.name}</span>
                    {b.member && <CheckIcon className="ml-auto" aria-label="Already in" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {journalHref && (
            <DropdownMenuItem asChild>
              <Link href={journalHref}>
                <NotebookPenIcon aria-hidden />
                Journal
              </Link>
            </DropdownMenuItem>
          )}
          {item && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setEditing(true)}>
                <PencilIcon aria-hidden />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  if (window.confirm(`Archive ${item.symbol}? It leaves the active list and stops linking to new buys.`))
                    start(() => archiveAction(item.id));
                }}
              >
                <ArchiveIcon aria-hidden />
                Archive
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {item && (
        <Dialog open={editing} onOpenChange={setEditing}>
          <DialogContent aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>Edit {item.symbol}</DialogTitle>
            </DialogHeader>
            {editing && <EditForm item={item} done={() => setEditing(false)} />}
          </DialogContent>
        </Dialog>
      )}
      {instrument && <TargetEditor instrument={instrument} open={targeting} onOpenChange={setTargeting} />}
    </>
  );
}
