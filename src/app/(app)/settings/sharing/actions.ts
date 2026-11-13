"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { accessGrants, shareLinks } from "@/db/schema";
import { authorize } from "@/lib/auth/access";
import { isOwnerEmail } from "@/lib/auth/grants";
import { hashToken, mintToken } from "@/lib/auth/share-link";

export type InviteResult = { ok: true } | { error: string } | null;
export type MintResult = { token: string } | { error: string } | null;

const PATH = "/settings/sharing";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `<input type="date">` → end of that day in IST (the owner's zone); "" → never. */
function parseExpiry(fd: FormData): Date | null | "invalid" {
  const v = String(fd.get("expiresOn") ?? "");
  if (!v) return null;
  const d = new Date(`${v}T23:59:59.999+05:30`);
  return Number.isNaN(d.getTime()) || d <= new Date() ? "invalid" : d;
}

export async function inviteGrant(_prev: InviteResult, fd: FormData): Promise<InviteResult> {
  const actor = await authorize("manage");
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const role = String(fd.get("role") ?? "");
  const expiresAt = parseExpiry(fd);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Enter a valid email address." };
  if (isOwnerEmail(email)) return { error: "That is the owner's email; it always has full access." };
  if (role !== "contributor" && role !== "viewer") return { error: "Pick a role." };
  if (expiresAt === "invalid") return { error: "Expiry must be a future date." };

  const values = { role, hideAmounts: fd.get("hideAmounts") === "on", expiresAt, revokedAt: null } as const;
  // Re-inviting a revoked/expired email reuses its row (email is unique).
  await db
    .insert(accessGrants)
    .values({ email, createdBy: actor.email!, ...values })
    .onConflictDoUpdate({ target: accessGrants.email, set: values });
  revalidatePath(PATH);
  return { ok: true };
}

export async function revokeGrant(id: string) {
  await authorize("manage");
  if (!UUID.test(id)) throw new Error("Bad id");
  await db.update(accessGrants).set({ revokedAt: new Date() }).where(eq(accessGrants.id, id));
  revalidatePath(PATH);
}

/** Returns the raw token exactly once; only its sha256 is stored. */
export async function mintShareLink(_prev: MintResult, fd: FormData): Promise<MintResult> {
  await authorize("manage");
  const expiresAt = parseExpiry(fd);
  if (expiresAt === "invalid") return { error: "Expiry must be a future date." };
  const token = mintToken();
  await db.insert(shareLinks).values({
    tokenHash: hashToken(token),
    label: String(fd.get("label") ?? "").trim().slice(0, 80) || null,
    hideAmounts: fd.get("hideAmounts") === "on",
    expiresAt,
  });
  revalidatePath(PATH);
  return { token };
}

export async function revokeShareLink(id: string) {
  await authorize("manage");
  if (!UUID.test(id)) throw new Error("Bad id");
  await db.update(shareLinks).set({ revokedAt: new Date() }).where(eq(shareLinks.id, id));
  revalidatePath(PATH);
}
