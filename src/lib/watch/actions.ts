import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import { instruments, priceLatest, tags, watchItems, watchItemTags } from "@/db/schema";
import { type Actor, can } from "@/lib/auth/access";
import { findOrCreateInstrument, fetchLatestPrice } from "@/lib/market/instruments";
import { exactMatch, type SearchHit, searchSymbols } from "@/lib/market/search";
import type { Market } from "@/lib/returns/types";

// Watch item writes (U14). Each takes the actor and checks it here, so the server
// actions in src/app/(app)/watchlist/actions.ts stay thin and this file is testable.
// suggest = add (owner, contributor); edit_own = edit/archive (owner: all, contributor: own).

type WatchItem = typeof watchItems.$inferSelect;
type Q = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export class WatchError extends Error {
  name = "WatchError";
}

const TAG = /^[a-z0-9][a-z0-9 :._&-]{0,39}$/;
export const MAX_TAGS = 10;
export const MAX_PASTE = 50;

/** "Defence, Q4 ideas " → ["defence", "q4 ideas"]. Throws on a name the tags CHECK would reject. */
export function normalizeTags(input: string[]): string[] {
  const out = [...new Set(input.map((t) => t.trim().toLowerCase().replace(/\s+/g, " ")).filter(Boolean))];
  const bad = out.find((t) => !TAG.test(t));
  if (bad) throw new WatchError(`Tag "${bad}" must be 1-40 letters, digits, spaces or : . _ & -`);
  if (out.length > MAX_TAGS) throw new WatchError(`At most ${MAX_TAGS} tags per item.`);
  return out;
}

/** Comma/newline/space separated symbols, upper-cased, deduped, in order. */
export const parsePaste = (text: string) => [...new Set(text.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];

export function authorEmail(actor: Actor): string {
  const email = actor.email ?? (actor.kind === "owner" ? process.env.OWNER_EMAIL : undefined);
  if (!email) throw new WatchError("No email to stamp on the item.");
  return email.toLowerCase();
}

async function ensureTags(q: Q, names: string[], by: string): Promise<string[]> {
  if (!names.length) return [];
  await q
    .insert(tags)
    .values(names.map((name) => ({ name, createdBy: by })))
    .onConflictDoNothing();
  const rows = await q.select({ id: tags.id }).from(tags).where(inArray(tags.name, names));
  return rows.map((r) => r.id);
}

async function addTags(q: Q, itemId: string, names: string[], by: string) {
  const ids = await ensureTags(q, names, by);
  if (ids.length)
    await q
      .insert(watchItemTags)
      .values(ids.map((tagId) => ({ watchItemId: itemId, tagId })))
      .onConflictDoNothing();
}

const activeFor = async (instrumentId: string) =>
  (await db.select().from(watchItems).where(and(eq(watchItems.instrumentId, instrumentId), isNull(watchItems.archivedAt))))[0];

type AddOpts = { priceAtAdd?: number; note?: string; tags?: string[]; now?: Date; by?: string };

/**
 * Add (or return) the active watch item for an instrument. Price at add: the given
 * price (manual), else an on-demand Yahoo quote, else the stored latest price.
 */
async function addForInstrument(
  instrument: typeof instruments.$inferSelect,
  by: string,
  opts: AddOpts,
): Promise<{ item: WatchItem; created: boolean }> {
  const existing = await activeFor(instrument.id);
  if (existing) return { item: existing, created: false };

  let price: { value: number; source: string } | null = null;
  if (opts.priceAtAdd != null) price = { value: opts.priceAtAdd, source: "manual" };
  else {
    const q = await fetchLatestPrice(instrument);
    if (q) price = { value: q.price, source: "yahoo" };
    else {
      const [stored] = await db.select().from(priceLatest).where(eq(priceLatest.instrumentId, instrument.id));
      if (stored) price = { value: Number(stored.price), source: "latest" };
    }
  }

  return db.transaction(async (tx) => {
    // The partial unique index settles a race between two adders: the loser reads the winner's row.
    const [row] = await tx
      .insert(watchItems)
      .values({
        instrumentId: instrument.id,
        addedAt: opts.now ?? new Date(),
        priceAtAdd: price ? String(Number(price.value.toFixed(6))) : null,
        priceAtAddSource: price?.source ?? "none",
        note: opts.note?.trim() || null,
        createdBy: by,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      const [winner] = await tx
        .select()
        .from(watchItems)
        .where(and(eq(watchItems.instrumentId, instrument.id), isNull(watchItems.archivedAt)));
      return { item: winner, created: false };
    }
    await addTags(tx, row.id, opts.tags ?? [], by);
    return { item: row, created: true };
  });
}

function validPrice(p: number | undefined) {
  if (p != null && !(Number.isFinite(p) && p > 0)) throw new WatchError("Price must be a positive number.");
}

export async function addWatchItem(actor: Actor, hit: SearchHit, opts: Omit<AddOpts, "by"> = {}) {
  if (!can(actor, "suggest")) throw new Error("Forbidden");
  validPrice(opts.priceAtAdd);
  const tagNames = normalizeTags(opts.tags ?? []);
  const instrument = await findOrCreateInstrument(hit);
  return addForInstrument(instrument, authorEmail(actor), { ...opts, tags: tagNames });
}

async function loadForEdit(actor: Actor, id: string) {
  const [item] = await db.select().from(watchItems).where(eq(watchItems.id, id));
  if (!item) throw new WatchError("Watch item not found.");
  if (!can(actor, "edit_own", { by: item.createdBy })) throw new Error("Forbidden");
  return item;
}

/** Edit price at add / note / tags (tags replace the item's set). */
export async function updateWatchItem(
  actor: Actor,
  id: string,
  patch: { priceAtAdd?: number | null; note?: string | null; tags?: string[] },
) {
  const item = await loadForEdit(actor, id);
  validPrice(patch.priceAtAdd ?? undefined);
  const tagNames = patch.tags ? normalizeTags(patch.tags) : null;
  const by = authorEmail(actor);
  await db.transaction(async (tx) => {
    const set: Partial<typeof watchItems.$inferInsert> = {};
    if (patch.priceAtAdd !== undefined) {
      const changed = patch.priceAtAdd == null ? item.priceAtAdd != null : Number(item.priceAtAdd) !== patch.priceAtAdd;
      if (changed) {
        set.priceAtAdd = patch.priceAtAdd == null ? null : String(patch.priceAtAdd);
        set.priceAtAddSource = patch.priceAtAdd == null ? "none" : "manual";
      }
    }
    if (patch.note !== undefined) set.note = patch.note?.trim().slice(0, 500) || null;
    if (Object.keys(set).length) await tx.update(watchItems).set(set).where(eq(watchItems.id, id));
    if (tagNames) {
      await tx.delete(watchItemTags).where(eq(watchItemTags.watchItemId, id));
      await addTags(tx, id, tagNames, by);
    }
  });
}

export async function archiveWatchItem(actor: Actor, id: string, now = new Date()) {
  await loadForEdit(actor, id);
  await db
    .update(watchItems)
    .set({ archivedAt: now })
    .where(and(eq(watchItems.id, id), isNull(watchItems.archivedAt)));
}

export type PasteResult = { added: string[]; existing: string[]; unresolved: string[] };

/**
 * Paste import: each token resolves by exact ticker via Yahoo search (see exactMatch).
 * Sequential on purpose: Yahoo rate-limits bursts, and a paste is at most MAX_PASTE symbols.
 */
export async function importPasted(actor: Actor, text: string, hint?: Market): Promise<PasteResult> {
  if (!can(actor, "suggest")) throw new Error("Forbidden");
  const tokens = parsePaste(text);
  if (tokens.length > MAX_PASTE) throw new WatchError(`Paste at most ${MAX_PASTE} symbols at a time.`);
  const out: PasteResult = { added: [], existing: [], unresolved: [] };
  for (const t of tokens) {
    const hit = exactMatch(t, await searchSymbols(t), hint);
    if (!hit) {
      out.unresolved.push(t);
      continue;
    }
    const r = await addWatchItem(actor, hit);
    (r.created ? out.added : out.existing).push(t);
  }
  return out;
}

/**
 * Broker watchlist → watch items tagged `source:<broker>` (idempotent). Called by the
 * sync job (U10) with no actor: items are stamped with the owner's email. A symbol the
 * owner already watches just gains the tag; one the owner archived (with that tag)
 * stays archived instead of reappearing on every sync.
 */
export async function importBrokerWatchlist(
  broker: "kite" | "indmoney",
  items: { symbol: string; market: Market }[],
  now = new Date(),
): Promise<PasteResult> {
  const owner = process.env.OWNER_EMAIL?.toLowerCase();
  if (!owner) throw new WatchError("OWNER_EMAIL is not set.");
  const tag = `source:${broker}`;
  const out: PasteResult = { added: [], existing: [], unresolved: [] };
  for (const { symbol, market } of items) {
    const sym = symbol.trim().toUpperCase();
    let [instrument] = await db
      .select()
      .from(instruments)
      .where(and(eq(instruments.market, market), eq(instruments.brokerSymbol, sym)));
    if (!instrument) {
      const hit = exactMatch(sym, await searchSymbols(market === "US" ? sym.replace(/\./g, "-") : sym), market);
      if (!hit) {
        out.unresolved.push(sym);
        continue;
      }
      instrument = await findOrCreateInstrument(hit);
    }
    const archivedFromBroker = await db
      .select({ id: watchItems.id })
      .from(watchItems)
      .innerJoin(watchItemTags, eq(watchItemTags.watchItemId, watchItems.id))
      .innerJoin(tags, eq(tags.id, watchItemTags.tagId))
      .where(and(eq(watchItems.instrumentId, instrument.id), isNotNull(watchItems.archivedAt), eq(tags.name, tag)))
      .limit(1);
    if (archivedFromBroker.length && !(await activeFor(instrument.id))) {
      out.existing.push(sym);
      continue;
    }
    const r = await addForInstrument(instrument, owner, { now, tags: [tag] });
    if (!r.created) await addTags(db, r.item.id, [tag], owner);
    (r.created ? out.added : out.existing).push(sym);
  }
  return out;
}
