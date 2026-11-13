"use client";

import { Loader2Icon, MoreHorizontalIcon, PencilIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { type ReactNode, useId, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { toast } from "sonner";
import { Delta, formatMoney } from "@/components/money";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { priceFromPct, type TargetKind, upside, validateLevel } from "@/lib/targets/evaluate";
import { cn } from "@/lib/utils";
import type { InstrumentOption } from "@/lib/views/targets";
import { cancelTargetAction, reevaluateAction, saveTargetAction } from "./actions";

// Target editor drawer (U16), opened from holdings rows, watchlist rows and the targets
// page. Rendered only for actors allowed to use it; the server actions re-check anyway.
// The live preview uses the same pure helpers as the server (priceFromPct, validateLevel).

const TEXTAREA =
  "min-h-20 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

export type EditableTarget = {
  id: string;
  kind: TargetKind;
  price: number;
  inputMode: "abs" | "pct";
  pctValue: number | null;
  deadline: string | null;
  note: string | null;
};

/** Client radio group styled like the URL Segmented control; a native input, so FormData carries it. */
export function Toggle<T extends string>({
  name,
  legend,
  value,
  onChange,
  options,
}: {
  name: string;
  legend: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      <div className="inline-flex w-full rounded-lg border bg-muted/50 p-0.5">
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              "inline-flex min-h-10 flex-1 cursor-pointer items-center justify-center rounded-md px-3 text-sm transition-colors has-focus-visible:ring-3 has-focus-visible:ring-ring/50 md:min-h-8",
              value === o.value ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="sr-only"
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Submit({ disabled, children }: { disabled: boolean; children: ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending || disabled} className="min-h-10 md:min-h-9">
      {pending && <Loader2Icon className="animate-spin motion-reduce:animate-none" aria-hidden />}
      {children}
    </Button>
  );
}

/** Tomorrow in the browser's calendar: the earliest deadline the server accepts (it re-checks in the market's zone). */
function tomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function EditorForm({
  instruments,
  fixed,
  target,
  defaultKind,
  done,
}: {
  instruments: InstrumentOption[];
  fixed: boolean;
  target?: EditableTarget;
  defaultKind: TargetKind;
  done: () => void;
}) {
  const id = useId();
  const [instrumentId, setInstrumentId] = useState((fixed || instruments.length === 1 ? instruments[0]?.id : "") ?? "");
  const [kind, setKind] = useState<TargetKind>(target?.kind ?? defaultKind);
  const [mode, setMode] = useState<"abs" | "pct">(target?.inputMode ?? "abs");
  const [value, setValue] = useState(() =>
    !target ? "" : target.inputMode === "pct" && target.pctValue != null ? String(+(Math.abs(target.pctValue) * 100).toFixed(4)) : String(target.price),
  );
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inst = instruments.find((i) => i.id === instrumentId);
  const current = inst?.price ?? null;
  const n = Number(value.replace(/,/g, ""));
  const entered = value.trim() !== "" && Number.isFinite(n);
  const level = !entered || current == null ? null : mode === "pct" ? priceFromPct(current, (kind === "stop" ? -n : n) / 100) : n;
  const invalid = level == null ? null : mode === "pct" && n <= 0 ? "Enter a percentage above zero." : validateLevel(kind, level, current!);
  const showInvalid = invalid && (touched || error != null);
  const word = kind === "target" ? "target" : "stop";

  return (
    <form
      action={async (fd) => {
        setTouched(true);
        if (invalid || level == null) return;
        const r = await saveTargetAction(null, fd);
        if (r && "error" in r) setError(r.error);
        else done();
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      {target && <input type="hidden" name="id" value={target.id} />}
      <div className="flex flex-col gap-5 overflow-y-auto px-4 pb-2">
        {fixed ? (
          <input type="hidden" name="instrumentId" value={instrumentId} />
        ) : (
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-symbol`}>Symbol</Label>
            <Select name="instrumentId" value={instrumentId} onValueChange={setInstrumentId}>
              <SelectTrigger id={`${id}-symbol`} className="h-10 w-full md:h-9">
                <SelectValue placeholder="Pick a held or watched symbol" />
              </SelectTrigger>
              <SelectContent>
                {instruments.map((i) => (
                  <SelectItem key={i.id} value={i.id}>
                    <span className="font-medium">{i.symbol}</span>
                    <span className="truncate text-xs text-muted-foreground">{i.name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <dl className="flex items-baseline justify-between gap-3 rounded-md bg-muted px-3 py-2.5 text-[13px]">
          <dt className="text-muted-foreground">LTP</dt>
          <dd className="num font-medium">
            {current != null && inst ? formatMoney(current, inst.currency, { decimals: 2 }) : inst ? "No price yet" : "Pick a symbol"}
          </dd>
        </dl>

        <Toggle
          name="kind"
          legend="Type"
          value={kind}
          onChange={setKind}
          options={[
            { value: "target", label: "Target" },
            { value: "stop", label: "Stop" },
          ]}
        />

        <div className="flex flex-col gap-2">
          <Toggle
            name="mode"
            legend="Set as"
            value={mode}
            onChange={(m) => {
              setMode(m);
              setValue("");
              setTouched(false);
            }}
            options={[
              { value: "abs", label: "Price" },
              { value: "pct", label: kind === "target" ? "% above now" : "% below now" },
            ]}
          />
          <Label htmlFor={`${id}-value`} className="sr-only">
            {mode === "pct" ? `Percent ${kind === "target" ? "above" : "below"} the current price` : `${word} price`}
          </Label>
          <div className="relative">
            <Input
              id={`${id}-value`}
              name="value"
              inputMode="decimal"
              autoComplete="off"
              required
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              onBlur={() => setTouched(true)}
              aria-invalid={showInvalid ? true : undefined}
              aria-describedby={`${id}-preview`}
              placeholder={mode === "pct" ? (kind === "target" ? "20" : "10") : current != null ? String(Math.round(current * (kind === "target" ? 1.1 : 0.9))) : ""}
              className="h-10 pr-8 font-mono md:h-9"
            />
            {mode === "pct" && (
              <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-muted-foreground" aria-hidden>
                %
              </span>
            )}
          </div>
          <p id={`${id}-preview`} aria-live="polite" className={cn("min-h-5 text-xs", showInvalid ? "text-destructive" : "text-muted-foreground")}>
            {showInvalid ? (
              invalid
            ) : level != null && inst ? (
              <>
                {kind === "target" ? "Target" : "Stop"} at{" "}
                <span className="num text-foreground">{formatMoney(level, inst.currency, { decimals: 2 })}</span>
                {", "}
                <Delta value={upside(level, current)} decimals={1} className="text-xs" /> from now
              </>
            ) : (
              `A ${word} must be ${kind === "target" ? "above" : "below"} the current price.`
            )}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-deadline`}>
            Deadline <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id={`${id}-deadline`}
            name="deadline"
            type="date"
            min={tomorrow()}
            defaultValue={target?.deadline ?? ""}
            className="h-10 md:h-9"
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-note`}>
            Note <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <textarea id={`${id}-note`} name="note" rows={3} maxLength={500} defaultValue={target?.note ?? ""} className={TEXTAREA} />
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <SheetFooter className="border-t">
        <Submit disabled={!inst || current == null}>{target ? "Save changes" : `Set ${word}`}</Submit>
      </SheetFooter>
    </form>
  );
}

/**
 * The drawer. Pass `instrument` for a row (holdings, watchlist) or `instruments` for the
 * page-level "New target" picker; `target` edits. Uncontrolled with a `children` trigger,
 * or controlled with open/onOpenChange (row menu).
 */
export function TargetEditor({
  instrument,
  instruments,
  target,
  defaultKind = "target",
  open,
  onOpenChange,
  children,
}: {
  instrument?: InstrumentOption;
  instruments?: InstrumentOption[];
  target?: EditableTarget;
  defaultKind?: TargetKind;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
}) {
  const [own, setOwn] = useState(false);
  const isOpen = open ?? own;
  const setOpen = onOpenChange ?? setOwn;
  const list = instrument ? [instrument] : (instruments ?? []);
  const title = target ? `Edit ${target.kind} for ${instrument?.symbol}` : instrument ? `New target for ${instrument.symbol}` : "New target";
  return (
    <Sheet open={isOpen} onOpenChange={setOpen}>
      {children && <SheetTrigger asChild>{children}</SheetTrigger>}
      <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        <SheetHeader className="border-b pr-12">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription className={instrument ? undefined : "sr-only"}>{instrument ? instrument.name : "Pick a symbol and a price level."}</SheetDescription>
        </SheetHeader>
        {isOpen && <EditorForm instruments={list} fixed={!!instrument} target={target} defaultKind={defaultKind} done={() => setOpen(false)} />}
      </SheetContent>
    </Sheet>
  );
}

/** Edit / cancel menu for an active target the actor may change. */
export function TargetRowActions({ instrument, target, label }: { instrument: InstrumentOption; target: EditableTarget; label: string }) {
  const [editing, setEditing] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-10 md:size-8"
            aria-label={`Actions for ${label}`}
            title={error ?? undefined}
            disabled={pending}
          >
            {pending ? <Loader2Icon className="animate-spin motion-reduce:animate-none" aria-hidden /> : <MoreHorizontalIcon aria-hidden />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            <PencilIcon aria-hidden />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              if (window.confirm(`Cancel ${label}? It moves to the history as cancelled and stops counting.`))
                start(async () => {
                  const r = await cancelTargetAction(target.id);
                  setError(r && "error" in r ? r.error : null);
                });
            }}
          >
            <XIcon aria-hidden />
            Cancel {target.kind}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <TargetEditor instrument={instrument} target={target} open={editing} onOpenChange={setEditing} />
    </>
  );
}

/** Owner: evaluate pending targets now against the stored daily bars (the EOD job does this nightly). */
export function ReevaluateButton() {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      size="icon"
      className="size-10 md:size-8"
      aria-label="Re-evaluate now"
      title="Re-evaluate now"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await reevaluateAction();
          toast(`Checked ${r.checked}, ${r.updated} changed`);
        })
      }
    >
      {pending ? <Loader2Icon className="animate-spin motion-reduce:animate-none" aria-hidden /> : <RefreshCwIcon aria-hidden />}
    </Button>
  );
}
