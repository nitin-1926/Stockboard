"use client";

import { FileTextIcon, Loader2Icon, UploadIcon } from "lucide-react";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { importConsoleAction, type ImportState, importUsAction } from "./actions";

const ACTIONS = { console: importConsoleAction, us: importUsAction };
const MAX_ERRORS = 50;

function Result({ state }: { state: ImportState }) {
  if (!state) return null;
  if ("error" in state)
    return (
      <p role="alert" className="text-[13px] text-destructive">
        {state.error}
      </p>
    );
  if ("errors" in state)
    return (
      <div role="alert" className="flex flex-col gap-2 text-[13px]">
        <p className="text-destructive">
          {state.errors.length} {state.errors.length === 1 ? "problem" : "problems"} found. Nothing was imported.
        </p>
        <ul className="flex max-h-64 flex-col divide-y overflow-y-auto rounded-md border font-mono text-xs">
          {state.errors.slice(0, MAX_ERRORS).map((e) => (
            <li key={`${e.row}:${e.message}`} className="px-3 py-1.5">
              <span className="text-faint">Row {e.row}</span> {e.message}
            </li>
          ))}
        </ul>
        {state.errors.length > MAX_ERRORS && <p className="text-xs text-faint">and {state.errors.length - MAX_ERRORS} more</p>}
      </div>
    );
  return (
    <div role="status" className="flex flex-col gap-3 text-[13px]">
      <dl className="flex gap-8">
        <div className="flex flex-col gap-1">
          <dt className="text-xs text-muted-foreground">Events added</dt>
          <dd className="num text-[15px] font-semibold">{state.inserted}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs text-muted-foreground">Estimates replaced</dt>
          <dd className="num text-[15px] font-semibold">{state.superseded}</dd>
        </div>
      </dl>
      {state.unexplained.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-muted-foreground">Still differ from the broker, added to the review queue:</p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs">
            {state.unexplained.map((u) => (
              <li key={u.symbol}>
                {u.symbol} <span className="num text-muted-foreground">{u.residual > 0 ? "+" : ""}{u.residual} shares</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-muted-foreground">Quantities match the latest broker snapshot.</p>
      )}
    </div>
  );
}

export function ImportForm({ kind }: { kind: keyof typeof ACTIONS }) {
  const [state, action, pending] = useActionState(ACTIONS[kind], null);
  const [file, setFile] = useState<string | null>(null);
  const id = `import-${kind}`;
  const Icon = file ? FileTextIcon : UploadIcon;
  return (
    <form action={action}>
      <div className="flex flex-col gap-4 p-4">
        {/* The native input covers the zone, so click and drag-and-drop both work without JS. */}
        <label
          htmlFor={id}
          className="relative flex flex-col items-center justify-center gap-1.5 rounded-md border border-dashed px-4 py-8 text-center transition-colors hover:bg-muted/60 has-[:focus-visible]:border-ring has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50"
        >
          <Icon className="size-4 text-faint" strokeWidth={1.75} aria-hidden />
          <span className="max-w-full truncate text-[13px] font-medium">{file ?? "Choose a CSV file"}</span>
          <span className="text-xs text-faint">{file ? "Click or drop to replace" : "or drop it here"}</span>
          <input
            id={id}
            name="file"
            type="file"
            accept=".csv,text/csv"
            required
            onChange={(e) => setFile(e.target.files?.[0]?.name ?? null)}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
        <Result state={state} />
      </div>
      <div className="flex justify-end border-t px-4 py-3">
        <Button type="submit" disabled={pending}>
          {pending && <Loader2Icon className="animate-spin motion-reduce:animate-none" aria-hidden />}
          {pending ? "Importing" : "Import"}
        </Button>
      </div>
    </form>
  );
}
