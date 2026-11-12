"use client";

import { Loader2Icon } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { type EnrichResult, enrichMissingAction } from "../overview-actions";

function summary(r: EnrichResult) {
  if (!r) return null;
  if ("error" in r) return r.error;
  if (r.limited) return "Rate limited, retry in a minute";
  return r.remaining > 0 ? `${r.enriched} classified, ${r.remaining} left` : `${r.enriched} classified`;
}

/** Owner only: fetch sectors from Yahoo for unclassified holdings, a few per click. */
export function ClassifySectors() {
  const [result, setResult] = useState<EnrichResult>(null);
  const [pending, start] = useTransition();
  return (
    <span className="flex items-center gap-2">
      <span role="status" className="text-xs text-faint">
        {summary(result)}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="-mr-2 h-7 px-2 text-xs text-muted-foreground"
        disabled={pending}
        onClick={() => start(async () => setResult(await enrichMissingAction().catch(() => ({ error: "Failed, try again" }))))}
      >
        {pending && <Loader2Icon className="animate-spin motion-reduce:animate-none" aria-hidden />}
        Classify sectors
      </Button>
    </span>
  );
}
