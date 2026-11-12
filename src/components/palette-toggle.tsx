"use client";

import { useSyncExternalStore } from "react";
import { PALETTE_KEY } from "@/lib/palette";
import { cn } from "@/lib/utils";

const html = () => document.documentElement;
function subscribe(onChange: () => void) {
  const o = new MutationObserver(onChange);
  o.observe(html(), { attributes: true, attributeFilter: ["data-palette"] });
  return () => o.disconnect();
}

/** Colorblind-safe gain/loss switch. Label it from outside (`id` + `<label htmlFor>`). */
export function PaletteToggle({ id, className }: { id?: string; className?: string }) {
  const on = useSyncExternalStore(
    subscribe,
    () => html().dataset.palette === "cb",
    () => false,
  );
  function toggle() {
    if (on) delete html().dataset.palette;
    else html().dataset.palette = "cb";
    try {
      localStorage.setItem(PALETTE_KEY, on ? "default" : "cb");
    } catch {}
  }
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={on}
      onClick={toggle}
      className={cn(
        "inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent p-0.5 transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        on ? "bg-brand" : "bg-foreground/15",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn("size-4 rounded-full bg-background shadow-sm transition-transform motion-reduce:transition-none", on && "translate-x-4")}
      />
    </button>
  );
}
