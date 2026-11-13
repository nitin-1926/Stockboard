"use server";

import { revalidatePath } from "next/cache";
import { authorize, requireActor } from "@/lib/auth/access";
import { baseSymbol, type SearchHit, searchSymbols } from "@/lib/market/search";
import { YahooError } from "@/lib/market/yahoo";
import { addWatchItem, archiveWatchItem, importPasted, type PasteResult, updateWatchItem, WatchError } from "@/lib/watch/actions";

// Thin wrappers: the actor checks live in src/lib/watch/actions.ts (suggest / edit_own).
// Expected failures come back as { error }; "Forbidden" still throws, since the UI never
// renders a control the actor can't use.

const PATH = "/watchlist";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function expected<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof WatchError) return { error: e.message };
    if (e instanceof YahooError) return { error: "Yahoo Finance did not answer. Try again in a minute." };
    throw e;
  }
}

export async function searchAction(query: string): Promise<SearchHit[] | { error: string }> {
  await authorize("suggest");
  return expected(() => searchSymbols(String(query).slice(0, 64)));
}

export type AddResult = { symbol: string; created: boolean } | { error: string };

/** Takes only the Yahoo symbol: the hit is re-resolved here, so a client can't invent a name or market. */
export async function addAction(symbol: string): Promise<AddResult> {
  const actor = await authorize("suggest");
  const sym = String(symbol).slice(0, 32);
  return expected(async () => {
    const hit = (await searchSymbols(sym)).find((h) => h.symbol === sym);
    if (!hit) throw new WatchError(`${sym} is not an NSE, BSE or US equity or ETF.`);
    const r = await addWatchItem(actor, hit);
    revalidatePath(PATH);
    return { symbol: baseSymbol(hit), created: r.created };
  });
}

export type FormResult = { ok: true } | { error: string } | null;

export async function updateAction(_prev: FormResult, fd: FormData): Promise<FormResult> {
  const actor = await requireActor();
  const id = String(fd.get("id") ?? "");
  if (!UUID.test(id)) return { error: "Bad item id." };
  const raw = String(fd.get("priceAtAdd") ?? "").trim();
  const price = raw === "" ? null : Number(raw.replace(/,/g, ""));
  if (price != null && !(Number.isFinite(price) && price > 0)) return { error: "Price at add must be a positive number." };
  const tags = String(fd.get("tags") ?? "")
    .split(",")
    .filter((t) => t.trim());
  return expected(async () => {
    await updateWatchItem(actor, id, { priceAtAdd: price, note: String(fd.get("note") ?? ""), tags });
    revalidatePath(PATH);
    return { ok: true as const };
  });
}

export async function archiveAction(id: string) {
  const actor = await requireActor();
  if (!UUID.test(id)) throw new Error("Bad id");
  await archiveWatchItem(actor, id);
  revalidatePath(PATH);
}

export type PasteState = PasteResult | { error: string } | null;

export async function pasteAction(_prev: PasteState, fd: FormData): Promise<PasteState> {
  const actor = await authorize("suggest");
  const hint = fd.get("market");
  const text = String(fd.get("symbols") ?? "").slice(0, 2000);
  if (!text.trim()) return { error: "Paste at least one symbol." };
  return expected(async () => {
    const r = await importPasted(actor, text, hint === "IN" || hint === "US" ? hint : undefined);
    revalidatePath(PATH);
    return r;
  });
}
