"use client";

import { Loader2Icon, PencilIcon, PlusIcon, SearchIcon, Settings2Icon, Trash2Icon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useActionState, useEffect, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { BucketSwatch } from "@/components/chip";
import { formatDate, formatMoney } from "@/components/money";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { BucketColor } from "@/db/schema/buckets";
import { PAPER_NOTIONAL_INR } from "@/lib/returns/aggregate";
import { cn } from "@/lib/utils";
import type { LotOption, WatchOption } from "@/lib/views/buckets";
import {
  addMemberAction,
  archiveBucketAction,
  type BucketFormResult,
  createBucketAction,
  removeMemberAction,
  updateBucketAction,
} from "./actions";

// Client islands for buckets. Rendered only for actors allowed to use them; every server
// action re-checks the actor anyway.

const TEXTAREA =
  "min-h-20 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

const COLORS: { key: BucketColor; label: string }[] = [
  { key: "chart-1", label: "Cobalt" },
  { key: "chart-2", label: "Teal" },
  { key: "chart-3", label: "Amber" },
  { key: "chart-4", label: "Plum" },
  { key: "chart-5", label: "Slate" },
];

function Submit({ children }: { children: ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending}>
      {pending && <Loader2Icon className="animate-spin motion-reduce:animate-none" aria-hidden />}
      {children}
    </Button>
  );
}

type Editable = { id: string; name: string; description: string | null; color: BucketColor };

function BucketForm({
  bucket,
  action,
  submit,
  onDone,
}: {
  bucket?: Editable;
  action: (prev: BucketFormResult, fd: FormData) => Promise<BucketFormResult>;
  submit: string;
  onDone: (id: string) => void;
}) {
  const [state, formAction] = useActionState(action, null);
  useEffect(() => {
    if (state && "ok" in state) onDone(state.id);
  }, [state, onDone]);
  return (
    <form action={formAction} className="flex flex-col gap-4">
      {bucket && <input type="hidden" name="id" value={bucket.id} />}
      <div className="flex flex-col gap-2">
        <Label htmlFor="bucket-name">Name</Label>
        <Input id="bucket-name" name="name" required maxLength={60} defaultValue={bucket?.name} placeholder="Manager picks" className="h-9" />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="bucket-description">Description</Label>
        <textarea
          id="bucket-description"
          name="description"
          rows={2}
          maxLength={280}
          defaultValue={bucket?.description ?? ""}
          placeholder="Optional"
          className={TEXTAREA}
        />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">Color</legend>
        <div className="flex flex-wrap gap-2">
          {COLORS.map((c) => (
            <label
              key={c.key}
              className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm has-checked:border-foreground/40 has-checked:bg-secondary has-focus-visible:ring-3 has-focus-visible:ring-ring/50 md:min-h-8"
            >
              <input type="radio" name="color" value={c.key} defaultChecked={(bucket?.color ?? "chart-1") === c.key} className="sr-only" />
              <BucketSwatch color={c.key} />
              {c.label}
            </label>
          ))}
        </div>
      </fieldset>
      {state && "error" in state && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <DialogFooter>
        <Submit>{submit}</Submit>
      </DialogFooter>
    </form>
  );
}

export function CreateBucket() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="h-10 md:h-8">
          <PlusIcon aria-hidden />
          New bucket
        </Button>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>New bucket</DialogTitle>
        </DialogHeader>
        {open && (
          <BucketForm
            action={createBucketAction}
            submit="Create"
            onDone={(id) => {
              setOpen(false);
              router.push(`/buckets/${id}`);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** "Manage": add members, edit (creator or owner), delete (owner). Renders nothing when none apply. */
export function BucketMenu({
  bucket,
  canEdit,
  canArchive,
  members,
}: {
  bucket: Editable;
  canEdit: boolean;
  canArchive: boolean;
  /** Add-members options; null when the actor may not add. */
  members: { lots: LotOption[]; watch: WatchOption[] } | null;
}) {
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [archiving, startArchive] = useTransition();
  if (!canEdit && !canArchive && !members) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="h-10 md:h-8" disabled={archiving}>
            {archiving ? <Loader2Icon className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Settings2Icon aria-hidden />}
            Manage
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          {members && (
            <DropdownMenuItem onSelect={() => setAdding(true)}>
              <PlusIcon aria-hidden />
              Add members
            </DropdownMenuItem>
          )}
          {canEdit && (
            <DropdownMenuItem onSelect={() => setEditing(true)}>
              <PencilIcon aria-hidden />
              Edit bucket
            </DropdownMenuItem>
          )}
          {canArchive && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => {
                  if (window.confirm(`Delete ${bucket.name}? It disappears for everyone. Lots and watch items are not touched.`))
                    startArchive(() => archiveBucketAction(bucket.id));
                }}
              >
                <Trash2Icon aria-hidden />
                Delete bucket
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Edit {bucket.name}</DialogTitle>
          </DialogHeader>
          {editing && <BucketForm bucket={bucket} action={updateBucketAction} submit="Save" onDone={() => setEditing(false)} />}
        </DialogContent>
      </Dialog>
      {members && <AddMembers bucketId={bucket.id} lots={members.lots} watch={members.watch} open={adding} onOpenChange={setAdding} />}
    </>
  );
}

type Option = { key: string; ref: { buyEventId: string } | { watchItemId: string }; title: string; detail: string; search: string };

function OptionList({ title, options, added, busy, onAdd }: { title: string; options: Option[]; added: Set<string>; busy: string | null; onAdd: (o: Option) => void }) {
  if (!options.length) return null;
  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-1 text-xs font-medium text-muted-foreground">{title}</h3>
      <ul className="flex flex-col">
        {options.map((o) => (
          <li key={o.key} className="flex min-h-11 items-center justify-between gap-3 rounded-md px-1 py-1.5 hover:bg-muted/60">
            <span className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">{o.title}</span>
              <span className="truncate text-xs text-muted-foreground">{o.detail}</span>
            </span>
            {added.has(o.key) ? (
              <span className="shrink-0 px-2 text-xs text-muted-foreground">Added</span>
            ) : (
              <Button size="sm" variant="outline" className="min-h-9 shrink-0" disabled={busy !== null} onClick={() => onAdd(o)} aria-label={`Add ${o.title}, ${o.detail}`}>
                {busy === o.key ? <Loader2Icon className="animate-spin motion-reduce:animate-none" aria-hidden /> : <PlusIcon aria-hidden />}
                Add
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Pick open buy lots (holdings) or watch items to add. Lots show date and buy price, never quantity.
 * Uncontrolled with a `children` trigger, or controlled with open/onOpenChange (Manage menu).
 */
export function AddMembers({
  bucketId,
  lots,
  watch,
  open,
  onOpenChange,
  children,
}: {
  bucketId: string;
  lots: LotOption[];
  watch: WatchOption[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
}) {
  const [own, setOwn] = useState(false);
  const [q, setQ] = useState("");
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();
  const all: { title: string; options: Option[] }[] = [
    {
      title: "Holdings",
      options: lots.map((l) => ({
        key: l.eventId,
        ref: { buyEventId: l.eventId },
        title: l.symbol,
        detail: `Bought ${formatDate(l.boughtOn)} at ${formatMoney(l.price, l.currency, { decimals: 2 })}`,
        search: `${l.symbol} ${l.name}`.toLowerCase(),
      })),
    },
    {
      title: "Watchlist, paper",
      options: watch.map((w) => ({
        key: w.watchItemId,
        ref: { watchItemId: w.watchItemId },
        title: w.symbol,
        detail: `Watched since ${formatDate(w.addedOn)}`,
        search: `${w.symbol} ${w.name}`.toLowerCase(),
      })),
    },
  ];
  const needle = q.trim().toLowerCase();
  const shown = all.map((g) => ({ ...g, options: g.options.filter((o) => !needle || o.search.includes(needle)) }));
  const empty = shown.every((g) => !g.options.length);

  function add(o: Option) {
    setBusy(o.key);
    setError(null);
    start(async () => {
      const r = await addMemberAction(bucketId, o.ref);
      setBusy(null);
      if ("error" in r) setError(r.error);
      else setAdded((s) => new Set(s).add(o.key));
    });
  }

  return (
    <Dialog
      open={open ?? own}
      onOpenChange={(o) => {
        (onOpenChange ?? setOwn)(o);
        if (!o) {
          setQ("");
          setAdded(new Set());
          setError(null);
        }
      }}
    >
      {children && <DialogTrigger asChild>{children}</DialogTrigger>}
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add members</DialogTitle>
          <DialogDescription>Paper items count at {formatMoney(PAPER_NOTIONAL_INR, "INR")} each.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Label htmlFor="member-filter" className="sr-only">
            Filter
          </Label>
          <Input id="member-filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by symbol or name" className="h-10 pl-8 md:h-9" autoComplete="off" />
        </div>
        <div className="-mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto">
          {shown.map((g) => (
            <OptionList key={g.title} title={g.title} options={g.options} added={added} busy={busy} onAdd={add} />
          ))}
          {empty && (
            <p className="px-1 py-6 text-sm text-muted-foreground">
              {needle ? "Nothing matches." : "Everything is already in this bucket."}
            </p>
          )}
        </div>
        <p role="status" className={cn("min-h-4 text-xs", error ? "text-destructive" : "text-muted-foreground")}>
          {error ?? (added.size ? `Added ${added.size}.` : "")}
        </p>
      </DialogContent>
    </Dialog>
  );
}

export function RemoveMember({ bucketId, memberId, label }: { bucketId: string; memberId: string; label: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-10 text-faint hover:text-foreground md:size-7"
      aria-label={`Remove ${label} from this bucket`}
      disabled={pending}
      onClick={() => {
        if (window.confirm(`Remove ${label} from this bucket? The lot or watch item itself stays.`))
          start(() => removeMemberAction(bucketId, memberId));
      }}
    >
      {pending ? <Loader2Icon className="animate-spin motion-reduce:animate-none" aria-hidden /> : <XIcon aria-hidden />}
    </Button>
  );
}

