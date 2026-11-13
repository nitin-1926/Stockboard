"use client";

import { CheckIcon, CopyIcon, Loader2Icon, PlusIcon } from "lucide-react";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type InviteResult, inviteGrant, mintShareLink } from "./actions";

function Submit({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending && <Loader2Icon className="animate-spin motion-reduce:animate-none" aria-hidden />}
      {children}
    </Button>
  );
}

/** Submit button that asks before a destructive action. */
export function ConfirmSubmit({ message, children }: { message: string; children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant="ghost"
      size="sm"
      disabled={pending}
      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </Button>
  );
}

const label = "text-xs font-normal text-muted-foreground";

function Field({ id, title, children, help }: { id: string; title: string; children: React.ReactNode; help?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className={label}>
        {title}
      </Label>
      {children}
      {help && <p className="text-xs text-faint">{help}</p>}
    </div>
  );
}

function HideAmounts({ id }: { id: string }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-2 text-[13px]">
      <input id={id} name="hideAmounts" type="checkbox" className="size-4 accent-foreground" />
      Hide amounts, show prices and percentages only
    </label>
  );
}

const Expiry = ({ id }: { id: string }) => (
  <Field id={id} title="Expires after" help="End of that day, IST. Empty means never.">
    <Input id={id} name="expiresOn" type="date" className="h-9 md:h-8" />
  </Field>
);

function FormError({ state }: { state: unknown }) {
  if (!state || typeof state !== "object" || !("error" in state)) return null;
  return (
    <p role="alert" className="text-xs text-destructive">
      {String(state.error)}
    </p>
  );
}

const trigger = (text: string) => (
  <DialogTrigger asChild>
    <Button variant="outline" size="sm">
      <PlusIcon aria-hidden />
      {text}
    </Button>
  </DialogTrigger>
);

export function InviteDialog() {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(async (prev: InviteResult, fd: FormData) => {
    const r = await inviteGrant(prev, fd);
    if (r && "ok" in r) {
      setOpen(false);
      toast.success("Access granted. They can now sign in with Google.");
    }
    return r;
  }, null);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger("Invite")}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite someone</DialogTitle>
          <DialogDescription>They sign in with this Google account.</DialogDescription>
        </DialogHeader>
        <form action={action} className="flex flex-col gap-4">
          <Field id="invite-email" title="Google account email">
            <Input id="invite-email" name="email" type="email" required autoComplete="off" className="h-9 md:h-8" />
          </Field>
          <Field id="invite-role" title="Role">
            <Select name="role" defaultValue="viewer">
              <SelectTrigger id="invite-role" className="h-9 w-full md:h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="viewer">Viewer, read only</SelectItem>
                <SelectItem value="contributor">Contributor, can suggest and add buckets</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Expiry id="invite-expiry" />
          <HideAmounts id="invite-hide" />
          <FormError state={state} />
          <DialogFooter>
            <Submit>Grant access</Submit>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Create form, then the one-time link, in the same dialog. */
export function MintLinkDialog() {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(mintShareLink, null);
  const [seenToken, setSeenToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const token = state && "token" in state && state.token !== seenToken ? state.token : null;
  const url = token ? `${window.location.origin}/s/${token}` : "";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // A link shown before is never shown again: reopening starts at the form.
        if (o && state && "token" in state) setSeenToken(state.token);
        setCopied(false);
        setOpen(o);
      }}
    >
      {trigger("Create link")}
      <DialogContent>
        {token ? (
          <>
            <DialogHeader>
              <DialogTitle>Share link created</DialogTitle>
              <DialogDescription>Copy it now, it is shown only once. Lost it? Revoke it and create another.</DialogDescription>
            </DialogHeader>
            <div className="flex gap-2">
              <Input readOnly value={url} aria-label="Share link" className="h-9 font-mono text-xs md:h-8" onFocus={(e) => e.target.select()} />
              <Button
                type="button"
                variant="outline"
                onClick={async () => {
                  await navigator.clipboard.writeText(url);
                  setCopied(true);
                }}
              >
                {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <DialogFooter>
              <Button
                type="button"
                onClick={() => setOpen(false)}
              >
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create share link</DialogTitle>
              <DialogDescription>Read-only view for anyone with the link.</DialogDescription>
            </DialogHeader>
            <form action={action} className="flex flex-col gap-4">
              <Field id="link-label" title="Label">
                <Input id="link-label" name="label" maxLength={80} placeholder="Family" className="h-9 md:h-8" />
              </Field>
              <Expiry id="link-expiry" />
              <HideAmounts id="link-hide" />
              <FormError state={state} />
              <DialogFooter>
                <Submit>Create link</Submit>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
