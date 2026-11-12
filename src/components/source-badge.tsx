// Ledger event source badge (trades feed, ledger page): label plus a tooltip saying where the entry came from.
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { TradeSource } from "@/lib/views/trades";

export const SOURCE: Record<TradeSource, { label: string; help: string }> = {
  fill: { label: "Broker fill", help: "An executed trade reported by the broker." },
  csv: { label: "Tradebook", help: "Imported from the Zerodha Console tradebook." },
  us_history: { label: "US history", help: "Imported from the US trade history file." },
  inferred: { label: "Estimated", help: "Worked out from a change in holdings. Replaced when the broker fill or tradebook arrives." },
  manual: { label: "Corrected", help: "Entered or corrected by the owner. Nothing replaces it automatically." },
  opening: { label: "Opening", help: "Holdings found on the first sync, at the broker's average price." },
  action: { label: "Corporate action", help: "A split, bonus or dividend from the corporate actions on record." },
};

export function SourceBadge({ source }: { source: TradeSource }) {
  const s = SOURCE[source];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          tabIndex={0}
          aria-label={`${s.label}. ${s.help}`}
          className={cn("cursor-help font-sans font-normal", (source === "inferred" || source === "opening") && "border-dashed")}
        >
          {s.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{s.help}</TooltipContent>
    </Tooltip>
  );
}
