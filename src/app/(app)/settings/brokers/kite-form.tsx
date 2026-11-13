"use client";

import { Loader2Icon } from "lucide-react";
import { type ReactNode, useActionState, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type FormResult, saveKiteCredentials } from "./actions";

const FIELDS = [
  { name: "userId", label: "Kite user ID", type: "text", autoComplete: "off" },
  { name: "password", label: "Password", type: "password", autoComplete: "new-password" },
  { name: "totpSecret", label: "TOTP secret", type: "password", autoComplete: "off" },
] as const;

/**
 * Panel footer for the Kite panel: "Update credentials" on the left, the job actions (`children`)
 * on the right. Opening it swaps the footer for the write-only credentials form: fields always
 * start empty, saved values are never sent back.
 */
export function KiteCredentials({ credentialsSet, children }: { credentialsSet: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(async (prev: FormResult, fd: FormData) => {
    const r = await saveKiteCredentials(prev, fd);
    if (r && "ok" in r) {
      setOpen(false);
      toast.success("Credentials saved.");
    }
    return r;
  }, null);

  if (!open)
    return (
      <div className="flex flex-col-reverse gap-2 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <Button type="button" variant="ghost" className="text-muted-foreground sm:-ml-2.5" aria-expanded={false} onClick={() => setOpen(true)}>
          {credentialsSet ? "Update credentials" : "Add credentials"}
        </Button>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center max-sm:[&_button]:w-full">{children}</div>
      </div>
    );

  return (
    <form action={action} className="border-t">
      <div className="grid gap-4 px-4 py-4 sm:grid-cols-3">
        {FIELDS.map((f, i) => (
          <div key={f.name} className="flex flex-col gap-1.5">
            <Label htmlFor={`kite-${f.name}`} className="text-xs font-normal text-muted-foreground">
              {f.label}
            </Label>
            <Input id={`kite-${f.name}`} required spellCheck={false} autoFocus={i === 0} className="h-9 md:h-8" {...f} />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
        {state && "error" in state ? (
          <p role="alert" className="text-xs text-destructive">
            {state.error}
          </p>
        ) : (
          <p className="text-xs text-faint">Encrypted at rest, never shown again.</p>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin motion-reduce:animate-none" aria-hidden />}
            {credentialsSet ? "Replace credentials" : "Save credentials"}
          </Button>
        </div>
      </div>
    </form>
  );
}
