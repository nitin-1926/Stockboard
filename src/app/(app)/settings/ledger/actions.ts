"use server";

import { revalidatePath } from "next/cache";
import { authorize } from "@/lib/auth/access";
import { correctEvent, reclassifyAsBonus, resolveReviewItem } from "@/lib/ledger/ingest";

export type LedgerActionState = { ok: string } | { error: string } | null;

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
};

async function run(work: () => Promise<string>): Promise<LedgerActionState> {
  try {
    const ok = await work();
    // Every money view reads the ledger.
    revalidatePath("/", "layout");
    return { ok };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Correct an event's date and/or price: a manual event supersedes it. */
export async function correctEventAction(_prev: LedgerActionState, fd: FormData): Promise<LedgerActionState> {
  const actor = await authorize("manage");
  const id = str(fd, "eventId");
  const date = str(fd, "date");
  const priceText = str(fd, "price");
  const price = priceText ? Number(priceText) : undefined;
  if (priceText && !Number.isFinite(price)) return { error: "Price must be a number" };
  return run(async () => {
    await correctEvent(id, { date: date || undefined, price }, actor);
    return "Saved. The corrected entry replaces the old one.";
  });
}

export async function reclassifyAction(_prev: LedgerActionState, fd: FormData): Promise<LedgerActionState> {
  const actor = await authorize("manage");
  return run(async () => {
    await reclassifyAsBonus(str(fd, "instrumentId"), str(fd, "exDate"), actor);
    return "Reclassified as a bonus.";
  });
}

export async function resolveReviewAction(_prev: LedgerActionState, fd: FormData): Promise<LedgerActionState> {
  const actor = await authorize("manage");
  const resolution = str(fd, "resolution") === "ignored" ? "ignored" : "resolved";
  return run(async () => {
    await resolveReviewItem(str(fd, "itemId"), resolution, actor);
    return resolution === "ignored" ? "Ignored." : "Marked resolved.";
  });
}
