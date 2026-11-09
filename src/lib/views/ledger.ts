// Server-only view module for the owner's ledger page: the open review queue (U11b/U17
// anomalies) and the full event history of one instrument. Owner only; returns null for
// anyone else so the page can say so.
import { asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { instruments, ledgerReviewQueue } from "@/db/schema";
import { can, requireActor } from "@/lib/auth/access";
import { formatMoney } from "@/components/money";
import { liveEvents } from "@/lib/ledger/lots";
import type { Currency, ISODate } from "@/lib/returns/types";
import { buildTrades, loadTradesInputs, type TradeInstrument, type TradeRow } from "./trades";

export type ReviewKind = (typeof ledgerReviewQueue.$inferSelect)["kind"];

export const REVIEW_LABEL: Record<ReviewKind, string> = {
  pending_lag: "Waiting for a trade to settle",
  unexplained: "Unexplained change",
  oversell: "Sold more than held",
  approximate_sell: "Estimated sell price",
  price_fallback: "Cost from the broker average",
  unexplained_opening: "Shares from before the import",
  cost_mismatch: "Cost differs from the broker",
  exceeds_broker: "More than the broker holds",
};

/** The event a review item is about, when it is one the owner can correct. */
export interface CorrectableEvent {
  id: string;
  type: TradeRow["type"];
  date: ISODate;
  price: number;
  currency: Currency;
  source: TradeRow["source"];
}

export interface ReviewItemRow {
  id: string;
  kind: ReviewKind;
  label: string;
  message: string;
  instrumentId: string;
  symbol: string;
  createdAt: string;
  event: CorrectableEvent | null;
}

export interface LedgerView {
  items: ReviewItemRow[];
  instruments: TradeInstrument[];
  selected: TradeInstrument | null;
  /** Every event of the selected instrument, replaced ones included, newest first. */
  events: TradeRow[];
  /** Live, correctable event ids of the selected instrument. */
  correctable: Record<string, CorrectableEvent>;
}

const CORRECTABLE_TYPES = new Set(["buy", "sell", "opening", "dividend"]);

function messageOf(kind: ReviewKind, d: Record<string, unknown>, currency: Currency): string {
  if (typeof d.message === "string") return d.message;
  if (typeof d.reason === "string") return d.reason;
  const n = (k: string) => (typeof d[k] === "number" ? (d[k] as number) : null);
  if (kind === "pending_lag")
    return `Holdings moved by ${n("residual") ?? "?"} shares while a recent trade may not have settled. Rechecked on the next sync.`;
  if (kind === "approximate_sell") {
    const p = n("price");
    const src = d.priceSource === "latest" ? "the latest quote" : d.priceSource === "ltp" ? "the broker's last price" : "a quote";
    return `Priced at ${src}${p != null ? ` (${formatMoney(p, currency, { decimals: 2 })})` : ""}. The closing price replaces it after the market closes, or correct it here.`;
  }
  return "No detail recorded.";
}

export async function getLedgerView(instrumentId?: string): Promise<LedgerView | null> {
  const actor = await requireActor();
  if (!can(actor, "manage")) return null;

  const [rows, trades] = await Promise.all([
    db
      .select({ q: ledgerReviewQueue, i: instruments })
      .from(ledgerReviewQueue)
      .innerJoin(instruments, eq(instruments.id, ledgerReviewQueue.instrumentId))
      .where(isNull(ledgerReviewQueue.resolvedAt))
      .orderBy(asc(ledgerReviewQueue.createdAt)),
    loadTradesInputs(),
  ]);
  const live = new Set(liveEvents(trades.events, trades.supersessions).map((e) => e.id));
  const correctable = (id: unknown): CorrectableEvent | null => {
    const e = typeof id === "string" ? trades.events.find((x) => x.id === id) : undefined;
    if (!e || !live.has(e.id) || !CORRECTABLE_TYPES.has(e.type)) return null;
    return { id: e.id, type: e.type, date: e.date, price: e.price, currency: e.currency, source: e.source };
  };

  const items = rows.map(({ q, i }): ReviewItemRow => ({
    id: q.id,
    kind: q.kind,
    label: REVIEW_LABEL[q.kind],
    message: messageOf(q.kind, q.detail, i.currency),
    instrumentId: i.id,
    symbol: i.brokerSymbol,
    createdAt: q.createdAt.toISOString(),
    event: correctable(q.detail.eventId),
  }));

  const list = [...trades.instruments].sort((a, b) => a.symbol.localeCompare(b.symbol));
  const selected = list.find((x) => x.id === instrumentId) ?? null;
  const events = selected
    ? (buildTrades(trades, actor, { market: "all", type: "all", history: true, instrumentId: selected.id }).rows as TradeRow[])
    : [];
  return {
    items,
    instruments: list,
    selected,
    events,
    correctable: Object.fromEntries(events.flatMap((e) => {
      const c = correctable(e.id);
      return c ? [[e.id, c]] : [];
    })),
  };
}
