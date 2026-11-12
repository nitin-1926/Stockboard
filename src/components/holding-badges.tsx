// Inline row markers shared by the holdings table, symbol lots and bucket pages. Tags carry
// their meaning in visible text (title for the long form), so nothing depends on hover or color.
import { Tag } from "@/components/panel";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export const APPROX_HELP =
  "Approximate cost: bought before the ledger starts, so the date and price come from the first sync. Import the tradebook to make it exact.";

/** The one glyph used for an approximate cost, on detail pages only (never in primary tables). */
export function ApproxMark() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="cursor-help rounded px-0.5 font-sans text-faint" aria-label="Approximate cost">
          ≈
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{APPROX_HELP}</TooltipContent>
    </Tooltip>
  );
}

export const T1Badge = () => <Tag title="Includes shares that have not settled yet">T+1</Tag>;

export const NoPriceBadge = () => (
  <Tag title="No current price, left out of every total" className="border-dashed">
    No price
  </Tag>
);
