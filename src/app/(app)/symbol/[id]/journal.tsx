"use client";

import { Loader2Icon, MoreHorizontalIcon, NotebookPenIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useId, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { formatDate } from "@/components/money";
import { Tag } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { JOURNAL_KINDS, JOURNAL_MAX_BODY, type JournalKind } from "@/lib/journal/kinds";
import { cn } from "@/lib/utils";
import type { JournalEntryDto } from "@/lib/views/journal";
import { Toggle } from "../../targets/editor";
import { createJournalAction, deleteJournalAction, editJournalAction } from "./journal-actions";

// Journal client islands (U20): the composer, an entry with its own edit/delete, and the
// watchlist row sheet. Rendered only for actors allowed to use them; the server actions
// re-check anyway.

const TEXTAREA =
  "min-h-28 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

export const KIND_LABEL: Record<JournalKind, string> = { thesis: "Thesis", review: "Review", note: "Note" };
const KIND_TONE = { thesis: "brand", review: "neutral", note: "neutral" } as const satisfies Record<JournalKind, string>;
const PLACEHOLDER: Record<JournalKind, string> = {
  thesis: "Why buy or watch this? What has to happen for it to work, and what would prove it wrong?",
  review: "How did it play out against the thesis? What would you do differently?",
  note: "Anything worth remembering: results, news, a change of mind.",
};

export function KindBadge({ kind }: { kind: JournalKind }) {
  return (
    <Tag tone={KIND_TONE[kind]}>{KIND_LABEL[kind]}</Tag>
  );
}

function Submit({ children }: { children: ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending} className="min-h-10 md:min-h-9">
      {pending && <Loader2Icon className="animate-spin motion-reduce:animate-none" aria-hidden />}
      {children}
    </Button>
  );
}

export type SubjectOption = { value: string; label: string };

/**
 * New entry. `options` are "<subject_type>:<id>" values; one option → no picker.
 * `review` prefill (from Due for review): kind review on that target, focused.
 */
export function JournalComposer({
  options,
  defaultSubject,
  defaultKind = "thesis",
  autoFocus = false,
  onSaved,
}: {
  options: SubjectOption[];
  defaultSubject?: string;
  defaultKind?: JournalKind;
  autoFocus?: boolean;
  onSaved?: () => void;
}) {
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const [kind, setKind] = useState<JournalKind>(defaultKind);
  const [subject, setSubject] = useState(defaultSubject ?? options[0]?.value ?? "");
  const [length, setLength] = useState(0);
  const [status, setStatus] = useState<{ error: boolean; text: string } | null>(null);
  const body = useRef<HTMLTextAreaElement>(null);
  // autoFocus isn't applied to server-rendered (hydrated) fields, so focus here; it also scrolls the composer into view.
  useEffect(() => {
    if (autoFocus) body.current?.focus();
  }, [autoFocus]);

  return (
    <form
      ref={form}
      action={async (fd) => {
        const r = await createJournalAction(null, fd);
        if (r && "error" in r) return setStatus({ error: true, text: r.error });
        form.current?.reset();
        setLength(0);
        setStatus({ error: false, text: `${KIND_LABEL[kind]} saved.` });
        onSaved?.();
      }}
      className="flex flex-col gap-4"
    >
      <div className="grid gap-4 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        <Toggle
          name="kind"
          legend="Kind"
          value={kind}
          onChange={setKind}
          options={JOURNAL_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
        />
        {options.length > 1 ? (
          <div className="flex min-w-0 flex-col gap-2">
            <Label htmlFor={`${id}-subject`}>About</Label>
            <Select name="subject" value={subject} onValueChange={setSubject}>
              <SelectTrigger id={`${id}-subject`} className="h-10 w-full min-w-0 md:h-9">
                <SelectValue placeholder="Pick a buy, watch item or target" />
              </SelectTrigger>
              <SelectContent>
                {options.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <input type="hidden" name="subject" value={subject} />
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-body`}>{KIND_LABEL[kind]}</Label>
        <textarea
          id={`${id}-body`}
          name="body"
          required
          rows={4}
          maxLength={JOURNAL_MAX_BODY}
          ref={body}
          placeholder={PLACEHOLDER[kind]}
          aria-describedby={`${id}-help`}
          onChange={(e) => {
            setLength(e.target.value.length);
            setStatus(null);
          }}
          className={TEXTAREA}
        />
        <p id={`${id}-help`} className="flex justify-end text-xs text-faint">
          <span className="sr-only">Everyone with access can read it, with your name. </span>
          <span className="num shrink-0">
            {length}/{JOURNAL_MAX_BODY}
          </span>
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="status" className={cn("min-h-4 text-sm", status?.error ? "text-destructive" : "text-muted-foreground")}>
          {status?.text}
        </p>
        <Submit>Save {KIND_LABEL[kind].toLowerCase()}</Submit>
      </div>
    </form>
  );
}

/** One timeline entry, with inline edit and delete when the actor may change it. */
export function JournalItem({ entry, subjectLabel }: { entry: JournalEntryDto; subjectLabel?: string }) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <article className="flex flex-col gap-2 px-4 py-3.5" aria-labelledby={`${id}-meta`}>
      <div className="flex items-start justify-between gap-3">
        <p id={`${id}-meta`} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <KindBadge kind={entry.kind} />
          {subjectLabel && <span className="min-w-0 truncate">{subjectLabel}</span>}
        </p>
        {entry.canEdit && !editing && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="-my-1.5 size-10 shrink-0 md:size-8" aria-label={`Actions for this ${KIND_LABEL[entry.kind].toLowerCase()}`} disabled={pending}>
                {pending ? <Loader2Icon className="animate-spin motion-reduce:animate-none" aria-hidden /> : <MoreHorizontalIcon aria-hidden />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36">
              <DropdownMenuItem onSelect={() => setEditing(true)}>
                <PencilIcon aria-hidden />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => {
                  if (window.confirm(`Delete this ${KIND_LABEL[entry.kind].toLowerCase()}? It disappears for everyone.`))
                    start(async () => {
                      const r = await deleteJournalAction(entry.id);
                      setError(r && "error" in r ? r.error : null);
                    });
                }}
              >
                <Trash2Icon aria-hidden />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {editing ? (
        <form
          action={async (fd) => {
            const r = await editJournalAction(entry.id, String(fd.get("body") ?? ""));
            if (r && "error" in r) setError(r.error);
            else {
              setError(null);
              setEditing(false);
            }
          }}
          className="flex flex-col gap-3"
        >
          <Label htmlFor={`${id}-edit`} className="sr-only">
            Edit {KIND_LABEL[entry.kind].toLowerCase()}
          </Label>
          <textarea id={`${id}-edit`} name="body" required rows={4} maxLength={JOURNAL_MAX_BODY} defaultValue={entry.body} autoFocus className={TEXTAREA} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="lg" className="min-h-10 md:min-h-9" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Submit>Save</Submit>
          </div>
        </form>
      ) : (
        <p className="max-w-[72ch] text-[13px] leading-relaxed break-words whitespace-pre-wrap">{entry.body}</p>
      )}

      <p className="text-xs text-faint">
        <span className="break-all">{entry.author}</span> · {formatDate(entry.createdAt)}
        {entry.edited && ", edited"}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </article>
  );
}

const chip = "inline-flex h-5 items-center gap-1 rounded-4xl border px-2 text-xs text-muted-foreground transition-colors hover:text-foreground";

/**
 * Watchlist row: the item's journal in a sheet, with a composer for actors who may write.
 * Read-only actors get a link to the symbol page when there is something to read.
 */
export function WatchJournal({
  item,
  entries,
  canWrite,
}: {
  item: { id: string; instrumentId: string; symbol: string; name: string };
  entries: JournalEntryDto[];
  canWrite: boolean;
}) {
  const [open, setOpen] = useState(false);
  const count = entries.length;
  if (!canWrite)
    return count ? (
      <Link href={`/symbol/${item.instrumentId}#journal`} className={chip}>
        <NotebookPenIcon className="size-3" aria-hidden />
        Journal <span className="num">{count}</span>
      </Link>
    ) : null;
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label={count ? `Journal for ${item.symbol}, ${count} ${count === 1 ? "entry" : "entries"}` : `Write a thesis for ${item.symbol}`}
          className={cn(chip, !count && "border-dashed")}
        >
          {count ? <NotebookPenIcon className="size-3" aria-hidden /> : <PlusIcon className="size-3" aria-hidden />}
          {count ? (
            <>
              Journal <span className="num">{count}</span>
            </>
          ) : (
            "Thesis"
          )}
        </button>
      </SheetTrigger>
      <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
        <SheetHeader className="border-b pr-12">
          <SheetTitle>Journal for {item.symbol}</SheetTitle>
          <SheetDescription>Why it is on the watchlist. {item.name}</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-6">
          {open && <JournalComposer options={[{ value: `watch_item:${item.id}`, label: "This watch item" }]} />}
          {count > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Earlier entries</h3>
              <div className="-mx-4 divide-y border-y sm:mx-0 sm:rounded-xl sm:border">
                {entries.map((e) => (
                  <JournalItem key={e.id} entry={e} />
                ))}
              </div>
            </div>
          )}
          <Link href={`/symbol/${item.instrumentId}#journal`} className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            Full journal for {item.symbol}, including buys and targets
          </Link>
        </div>
      </SheetContent>
    </Sheet>
  );
}
