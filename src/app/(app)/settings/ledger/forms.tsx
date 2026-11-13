"use client";

import { Loader2Icon } from "lucide-react";
import { type ReactNode, useActionState, useId, useState } from "react";
import { toast } from "sonner";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CorrectableEvent } from "@/lib/views/ledger";
import { correctEventAction, type LedgerActionState, reclassifyAction, resolveReviewAction } from "./actions";

type Action = (prev: LedgerActionState, fd: FormData) => Promise<LedgerActionState>;

/**
 * Success leaves the page: the resolved item or replaced entry re-renders without this form,
 * so success is a toast (the root layout's Toaster outlives it) and the dialog closes. Errors stay inline.
 */
function useLedgerAction(act: Action, onOk?: () => void) {
  return useActionState<LedgerActionState, FormData>(async (prev, fd) => {
    const r = await act(prev, fd);
    if (r && "ok" in r) {
      toast.success(r.ok);
      onOk?.();
    }
    return r;
  }, null);
}

function Status({ state }: { state: LedgerActionState }) {
  if (!state || !("error" in state)) return null;
  return (
    <p role="alert" className="text-xs text-destructive">
      {state.error}
    </p>
  );
}

function Pending({ pending, children }: { pending: boolean; children: ReactNode }) {
  return (
    <Button type="submit" disabled={pending}>
      {pending && <Loader2Icon className="animate-spin motion-reduce:animate-none" aria-hidden />}
      {children}
    </Button>
  );
}

function ActionDialog({ trigger, title, description, children }: { trigger: string; title: string; description: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground">
          {trigger}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children(() => setOpen(false))}
      </DialogContent>
    </Dialog>
  );
}

/** "Correct": new date and/or price → a manual event that replaces this one. */
export function CorrectForm({ event }: { event: CorrectableEvent }) {
  return (
    <ActionDialog trigger="Correct" title="Correct entry" description="Saves a corrected entry that replaces this one. The original stays as history.">
      {(close) => <CorrectFields event={event} onOk={close} />}
    </ActionDialog>
  );
}

function CorrectFields({ event, onOk }: { event: CorrectableEvent; onOk: () => void }) {
  const [state, action, pending] = useLedgerAction(correctEventAction, onOk);
  const id = useId();
  const label = "text-xs font-normal text-muted-foreground";
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="eventId" value={event.id} />
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-date`} className={label}>
            Date
          </Label>
          <Input id={`${id}-date`} name="date" type="date" defaultValue={event.date} required className="h-9 md:h-8" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-price`} className={label}>
            Price per share, {event.currency}
          </Label>
          <Input
            id={`${id}-price`}
            name="price"
            inputMode="decimal"
            defaultValue={String(event.price)}
            required
            pattern="[0-9]*[.]?[0-9]+"
            className="num h-9 md:h-8"
          />
        </div>
      </div>
      <Status state={state} />
      <DialogFooter>
        <Pending pending={pending}>Save correction</Pending>
      </DialogFooter>
    </form>
  );
}

/** Split → bonus, behind a confirm dialog: there is no automatic way back. */
export function ReclassifyForm({ instrumentId, exDate }: { instrumentId: string; exDate: string }) {
  return (
    <ActionDialog
      trigger="It was a bonus"
      title="Reclassify as bonus"
      description="The extra shares become a new lot at zero cost, dated when allotted. The original shares keep their cost and date. Holding periods and realized P&L change."
    >
      {(close) => <ReclassifyFields instrumentId={instrumentId} exDate={exDate} onOk={close} />}
    </ActionDialog>
  );
}

function ReclassifyFields({ instrumentId, exDate, onOk }: { instrumentId: string; exDate: string; onOk: () => void }) {
  const [state, action, pending] = useLedgerAction(reclassifyAction, onOk);
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="instrumentId" value={instrumentId} />
      <input type="hidden" name="exDate" value={exDate} />
      <Status state={state} />
      <DialogFooter>
        <Pending pending={pending}>Reclassify as bonus</Pending>
      </DialogFooter>
    </form>
  );
}

export function ResolveButtons({ itemId }: { itemId: string }) {
  const [state, action, pending] = useLedgerAction(resolveReviewAction);
  return (
    <form action={action} className="flex flex-wrap items-center gap-1">
      <input type="hidden" name="itemId" value={itemId} />
      <Button type="submit" name="resolution" value="ignored" variant="ghost" size="sm" disabled={pending} className="text-muted-foreground">
        Ignore
      </Button>
      <Button type="submit" name="resolution" value="resolved" variant="outline" size="sm" disabled={pending}>
        Mark resolved
      </Button>
      <Status state={state} />
    </form>
  );
}
