"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { instruments } from "@/db/schema";
import { authorize } from "@/lib/auth/access";

const input = z.object({ id: z.uuid(), sector: z.string().trim().max(60) });

/** Owner only. A manual sector wins over Yahoo (ETFs have none); an empty value hands it back to Yahoo. */
export async function setSectorAction(id: string, sector: string): Promise<{ error?: string }> {
  await authorize("manage");
  const p = input.safeParse({ id, sector });
  if (!p.success) return { error: "Sector must be 60 characters or fewer." };
  const value = p.data.sector || null;
  await db.update(instruments).set({ sector: value, sectorOverridden: value != null }).where(eq(instruments.id, p.data.id));
  revalidatePath(`/symbol/${p.data.id}`);
  revalidatePath("/");
  return {};
}
