// Server-only view module (same pattern as holdings.ts): getWatchlistView() resolves the
// actor, loads, and hands everything to the pure buildWatchlistView().
//
// Redaction: a watch item carries no amounts, only prices, dates and percentages, so a
// hide-amounts actor gets the same numbers (R4 keeps prices and %). The linked buy's
// quantity is deliberately never loaded. What IS restricted is the author's email for
// share-link viewers (anonymous): they see "Owner" / "Contributor" instead.
import { asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { instruments, ledgerEvents, priceLatest, tags, watchItems, watchItemTags } from "@/db/schema";
import { type Actor, can, requireActor } from "@/lib/auth/access";
import { isoInMarket } from "@/lib/ledger/queries";
import { ensureFresh } from "@/lib/market/live";
import { annualizeOrAbsolute, daysBetween } from "@/lib/returns/xirr";
import type { Currency, ISODate, Market } from "@/lib/returns/types";
import { type BucketChip, bucketIdsFor, listBuckets } from "./buckets";

export interface WatchInput {
  id: string;
  instrumentId: string;
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  exchange: string;
  addedAt: Date;
  priceAtAdd: number | null;
  priceAtAddSource: string;
  note: string | null;
  createdBy: string;
  archivedAt: Date | null;
  tags: string[];
  priceUnavailable: boolean;
  price: { price: number; asOf: Date; prevClose?: number | null } | null;
  linkedBuy: { price: number; date: ISODate } | null;
  /** Live buckets holding this item as a paper member (U15). */
  buckets?: BucketChip[];
}

export interface WatchlistInputs {
  items: WatchInput[];
  /** Live buckets (the "Add to bucket" picker). */
  buckets?: BucketChip[];
  ownerEmail: string | null;
  now: Date;
}

export interface WatchRow {
  id: string;
  instrumentId: string;
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  exchange: string;
  addedOn: ISODate;
  daysWatched: number;
  priceAtAdd: number | null;
  priceAtAddManual: boolean;
  price: number | null;
  priceAsOf: string | null;
  /** price / price at add − 1. */
  returnPct: number | null;
  /** price / previous close − 1 (price_latest.prev_close). */
  dayChangePct: number | null;
  /** Annualized (XIRR of the two flows) only once watched ≥ 365 days, else null. */
  annualizedPct: number | null;
  tags: string[];
  note: string | null;
  /** Email for signed-in actors; "Owner" / "Contributor" for share-link viewers. */
  createdBy: string;
  archived: boolean;
  /** "Bought at Y on D2": the first real buy after it was added, and Y vs the watch price. */
  linkedBuy: { price: number; date: ISODate; vsWatchPct: number | null } | null;
  /** Actor may edit/archive (owner: all, contributor: own). Drives which controls render. */
  canEdit: boolean;
  buckets: BucketChip[];
}

export interface WatchlistView {
  rows: WatchRow[];
  /** Active items only, by name. */
  tags: { name: string; count: number }[];
  counts: { active: number; archived: number };
  canAdd: boolean;
  /** Buckets an item can be added to; empty unless the actor may add (suggest). */
  buckets: BucketChip[];
  /** Freshest price timestamp among active items ("Live · updated 12:41:03"). */
  priceAsOf: string | null;
}

const ratio = (num: number | null | undefined, den: number | null | undefined) =>
  num != null && den != null && den > 0 ? num / den - 1 : null;

function buildRow(w: WatchInput, actor: Actor, ownerEmail: string | null, now: Date): WatchRow {
  const today = isoInMarket(now, w.currency).slice(0, 10);
  const addedOn = isoInMarket(w.addedAt, w.currency).slice(0, 10);
  const days = Math.max(0, daysBetween(addedOn, today));
  const price = w.priceUnavailable ? null : (w.price?.price ?? null);
  let annualizedPct: number | null = null;
  if (price != null && w.priceAtAdd != null && w.priceAtAdd > 0 && days >= 365) {
    annualizedPct = annualizeOrAbsolute([
      { date: addedOn, amount: -w.priceAtAdd },
      { date: today, amount: price },
    ]).xirr;
  }
  const author =
    actor.via === "share-link" ? (ownerEmail && w.createdBy === ownerEmail ? "Owner" : "Contributor") : w.createdBy;
  return {
    id: w.id,
    instrumentId: w.instrumentId,
    symbol: w.symbol,
    name: w.name,
    market: w.market,
    currency: w.currency,
    exchange: w.exchange,
    addedOn,
    daysWatched: days,
    priceAtAdd: w.priceAtAdd,
    priceAtAddManual: w.priceAtAddSource === "manual",
    price,
    priceAsOf: price != null && w.price ? w.price.asOf.toISOString() : null,
    returnPct: ratio(price, w.priceAtAdd),
    dayChangePct: price != null && w.price?.prevClose ? ratio(price, w.price.prevClose) : null,
    annualizedPct,
    tags: [...w.tags].sort(),
    note: w.note,
    createdBy: author,
    archived: w.archivedAt != null,
    linkedBuy: w.linkedBuy ? { ...w.linkedBuy, vsWatchPct: ratio(w.linkedBuy.price, w.priceAtAdd) } : null,
    canEdit: can(actor, "edit_own", { by: w.createdBy }),
    buckets: w.buckets ?? [],
  };
}

/** Pure: inputs → DTO for the actor. Newest first; the page re-sorts from the URL. */
export function buildWatchlistView(inputs: WatchlistInputs, actor: Actor): WatchlistView {
  const owner = inputs.ownerEmail?.toLowerCase() ?? null;
  const rows = inputs.items
    .map((w) => buildRow(w, actor, owner, inputs.now))
    .sort((a, b) => b.addedOn.localeCompare(a.addedOn) || a.symbol.localeCompare(b.symbol));
  const active = rows.filter((r) => !r.archived);
  const tagCounts = new Map<string, number>();
  for (const r of active) for (const t of r.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  return {
    rows,
    tags: [...tagCounts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name)),
    counts: { active: active.length, archived: rows.length - active.length },
    canAdd: can(actor, "suggest"),
    buckets: can(actor, "suggest") ? (inputs.buckets ?? []) : [],
    priceAsOf: active.map((r) => r.priceAsOf).filter((d): d is string => !!d).sort().at(-1) ?? null,
  };
}

export async function loadWatchlistInputs(now: Date): Promise<WatchlistInputs> {
  const rows = await db
    .select({ w: watchItems, i: instruments, p: priceLatest, buy: { price: ledgerEvents.price, date: ledgerEvents.date } })
    .from(watchItems)
    .innerJoin(instruments, eq(instruments.id, watchItems.instrumentId))
    .leftJoin(priceLatest, eq(priceLatest.instrumentId, watchItems.instrumentId))
    .leftJoin(ledgerEvents, eq(ledgerEvents.id, watchItems.linkedBuyEventId));
  const ids = rows.map((r) => r.w.id);
  const tagRows = ids.length
    ? await db
        .select({ itemId: watchItemTags.watchItemId, name: tags.name })
        .from(watchItemTags)
        .innerJoin(tags, eq(tags.id, watchItemTags.tagId))
        .where(inArray(watchItemTags.watchItemId, ids))
        .orderBy(asc(tags.name))
    : [];
  const [inBuckets, bucketList] = await Promise.all([bucketIdsFor("watch_item", ids), listBuckets()]);
  return {
    now,
    buckets: bucketList,
    ownerEmail: process.env.OWNER_EMAIL ?? null,
    items: rows.map(({ w, i, p, buy }) => ({
      id: w.id,
      instrumentId: i.id,
      symbol: i.brokerSymbol,
      name: i.name,
      market: i.market,
      currency: i.currency,
      exchange: i.exchange,
      addedAt: w.addedAt,
      priceAtAdd: w.priceAtAdd == null ? null : Number(w.priceAtAdd),
      priceAtAddSource: w.priceAtAddSource,
      note: w.note,
      createdBy: w.createdBy,
      archivedAt: w.archivedAt,
      tags: tagRows.filter((t) => t.itemId === w.id).map((t) => t.name),
      priceUnavailable: i.priceUnavailable,
      price: p ? { price: Number(p.price), asOf: p.asOf, prevClose: p.prevClose != null ? Number(p.prevClose) : null } : null,
      linkedBuy: buy?.price != null && buy.date ? { price: Number(buy.price), date: buy.date } : null,
      buckets: bucketList.filter((b) => inBuckets.get(w.id)?.includes(b.id)),
    })),
  };
}

export async function getWatchlistView(): Promise<WatchlistView> {
  const actor = await requireActor();
  // Live prices for active items, best-effort: never fails the page.
  const active = db.select({ id: watchItems.instrumentId }).from(watchItems).where(isNull(watchItems.archivedAt));
  await db
    .select()
    .from(instruments)
    .where(inArray(instruments.id, active))
    .then((list) => ensureFresh(list))
    .catch((e) => console.error("[watchlist] live price refresh failed", e));
  return buildWatchlistView(await loadWatchlistInputs(new Date()), actor);
}
