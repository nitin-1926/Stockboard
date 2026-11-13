"use server";

import { sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { authorize } from "@/lib/auth/access";
import { PREF_KEYS } from "@/lib/settings/preferences";

export type PrefsResult = { ok: true } | { error: string; field?: string } | null;

const CRORE = 1e7;

/** Owner-only. Inputs are in display units (%, ₹ crore, $ billion); stored in the units the readers use. */
export async function savePreferencesAction(_prev: PrefsResult, fd: FormData): Promise<PrefsResult> {
  await authorize("manage");
  const n = (k: string) => {
    const v = String(fd.get(k) ?? "").trim().replace(/,/g, "");
    return v === "" ? Number.NaN : Number(v);
  };
  const stockPct = n("stockPct");
  const sectorPct = n("sectorPct");
  const inLarge = n("inLargeCr");
  const inMid = n("inMidCr");
  const usLarge = n("usLargeBn");
  const usMid = n("usMidBn");
  const tds = n("indiaTdsPct");

  const pct = (v: number) => Number.isFinite(v) && v > 0 && v <= 100;
  if (!pct(stockPct)) return { error: "Single-stock limit must be between 0 and 100%.", field: "stockPct" };
  if (!pct(sectorPct)) return { error: "Sector limit must be between 0 and 100%.", field: "sectorPct" };
  if (!(inMid > 0 && inLarge > inMid)) return { error: "India: large-cap threshold must be above mid-cap, both above 0.", field: "inLargeCr" };
  if (!(usMid > 0 && usLarge > usMid)) return { error: "US: large-cap threshold must be above mid-cap, both above 0.", field: "usLargeBn" };
  if (!(Number.isFinite(tds) && tds >= 0 && tds < 100)) return { error: "India dividend TDS must be from 0 to under 100%.", field: "indiaTdsPct" };

  const rows = [
    { key: PREF_KEYS.stockPct, value: stockPct },
    { key: PREF_KEYS.sectorPct, value: sectorPct },
    { key: PREF_KEYS.capThresholds, value: { IN: { large: inLarge * CRORE, mid: inMid * CRORE }, US: { large: usLarge * 1e9, mid: usMid * 1e9 } } },
    // A fraction, the format dividendWithholding() reads.
    { key: PREF_KEYS.indiaTds, value: Math.round(tds * 100) / 10_000 },
  ];
  await db
    .insert(settings)
    .values(rows)
    .onConflictDoUpdate({ target: settings.key, set: { value: sql`excluded.value`, updatedAt: new Date() } });
  revalidatePath("/settings/preferences");
  revalidatePath("/");
  return { ok: true };
}
