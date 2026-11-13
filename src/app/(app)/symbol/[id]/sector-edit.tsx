"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setSectorAction } from "./sector-actions";

// Yahoo's sector names, so manual and fetched values group together on Overview.
const SECTORS = [
  "Basic Materials",
  "Communication Services",
  "Consumer Cyclical",
  "Consumer Defensive",
  "Energy",
  "Financial Services",
  "Healthcare",
  "Industrials",
  "Real Estate",
  "Technology",
  "Utilities",
  "Gold ETF",
  "Silver ETF",
  "Index ETF",
  "Debt ETF",
];

export function SectorEdit({
  id,
  sector,
}: {
  id: string;
  sector: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(sector ?? "");
  const [pending, start] = useTransition();
  if (!editing)
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="underline-offset-4 hover:text-foreground hover:underline"
      >
        {sector ? "Edit sector" : "Set sector"}
      </button>
    );
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await setSectorAction(id, value);
          if (r.error) toast.error(r.error);
          else setEditing(false);
        });
      }}
    >
      <label htmlFor="sector" className="sr-only">
        Sector
      </label>
      <Input
        id="sector"
        list="sectors"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="h-7 w-48 text-xs"
        autoFocus
      />
      <datalist id="sectors">
        {SECTORS.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <Button type="submit" size="sm" disabled={pending}>
        Save
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => setEditing(false)}
      >
        Cancel
      </Button>
    </form>
  );
}
