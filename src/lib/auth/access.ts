// Data-access-layer authorization. Every view module and server action calls
// requireActor() (or authorize()) itself; the layout and proxy never decide access,
// because a layout does not re-render on client navigation and proxy only sees cookies.
import { devBypassEmail } from "./dev-bypass";
import { eq } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { db } from "@/db";
import { session as sessionTable, shareLinks } from "@/db/schema";
import { auth } from "./config";
import { findGrant, type GrantRow, isActive, isOwnerEmail } from "./grants";
import { SHARE_COOKIE, verifyShareCookie } from "./share-link";

export type Role = "owner" | "contributor" | "viewer";
export type Actor = {
  kind: Role;
  email?: string;
  hideAmounts: boolean;
  via: "session" | "share-link";
};
export type Denial = "NOT_INVITED" | "ACCESS_EXPIRED" | "LINK_INVALID" | "SIGNED_OUT";
export type Action = "read" | "suggest" | "create_bucket" | "edit_own" | "delete_bucket" | "manage";
/** A record's author (`set_by` / `created_by` / `added_by` / `author`), for edit_own. */
export type OwnedResource = { by: string | null };

type Lifetime = { expiresAt: Date | null; revokedAt: Date | null };

/** Session email → actor. Owner first (case-insensitive), then an active grant. */
export function actorForEmail(
  email: string,
  grant: (Lifetime & Pick<GrantRow, "role" | "hideAmounts">) | null,
  now = new Date(),
): Actor | { denied: Denial } {
  const lower = email.toLowerCase();
  if (isOwnerEmail(lower)) return { kind: "owner", email: lower, hideAmounts: false, via: "session" };
  if (!grant) return { denied: "NOT_INVITED" };
  if (!isActive(grant, now)) return { denied: "ACCESS_EXPIRED" };
  return { kind: grant.role, email: lower, hideAmounts: grant.hideAmounts, via: "session" };
}

/** Share link → viewer, always. Nothing on the row can raise the role. */
export function actorForShareLink(
  link: (Lifetime & { hideAmounts: boolean }) | null,
  now = new Date(),
): Actor | null {
  if (!link || !isActive(link, now)) return null;
  return { kind: "viewer", hideAmounts: link.hideAmounts, via: "share-link" };
}

export function can(actor: Actor, action: Action, resource?: OwnedResource): boolean {
  switch (action) {
    case "read":
      return true;
    case "suggest":
    case "create_bucket":
      return actor.kind !== "viewer";
    case "edit_own":
      if (actor.kind === "owner") return true;
      return (
        actor.kind === "contributor" &&
        !!actor.email &&
        !!resource?.by &&
        resource.by.toLowerCase() === actor.email
      );
    case "delete_bucket":
    case "manage":
      return actor.kind === "owner";
  }
}

const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** Verifies the signed cookie, re-validates the link row, and touches last_used_at hourly. */
export async function actorForShareCookie(value: string | undefined, now = new Date()) {
  const id = verifyShareCookie(value);
  if (!id) return null;
  const [link] = await db.select().from(shareLinks).where(eq(shareLinks.id, id));
  const actor = actorForShareLink(link ?? null, now);
  if (actor && (!link.lastUsedAt || now.getTime() - link.lastUsedAt.getTime() > TOUCH_INTERVAL_MS)) {
    await db.update(shareLinks).set({ lastUsedAt: now }).where(eq(shareLinks.id, id));
  }
  return actor;
}

/** Per-request memoized resolution. Never throws; use requireActor() to gate. */
export const getActor = cache(async (): Promise<Actor | { denied: Denial }> => {
  // Access is per request (expiry and revocation use the current time): never prerender it.
  await connection();
  const session = await auth.api.getSession({ headers: await headers() });
  if (session) {
    const { email, id } = session.user;
    const r = actorForEmail(email, isOwnerEmail(email) ? null : await findGrant(email));
    // No access any more → sign out everywhere (sessions are DB-backed, no cookie cache).
    if ("denied" in r) await db.delete(sessionTable).where(eq(sessionTable.userId, id));
    return r;
  }
  const share = (await cookies()).get(SHARE_COOKIE)?.value;
  if (share) return (await actorForShareCookie(share)) ?? { denied: "LINK_INVALID" };
  const dev = devBypassEmail();
  if (dev) return actorForEmail(dev, null);
  return { denied: "SIGNED_OUT" };
});

export async function requireActor(): Promise<Actor> {
  const r = await getActor();
  if (!("denied" in r)) return r;
  // /s/expired is not a valid token, so that route clears the cookie and shows the invalid page.
  if (r.denied === "LINK_INVALID") redirect("/s/expired");
  redirect(r.denied === "SIGNED_OUT" ? "/sign-in" : `/sign-in?error=${r.denied}`);
}

/** For server actions: resolve the actor and enforce `action`, or throw. */
export async function authorize(action: Action, resource?: OwnedResource): Promise<Actor> {
  const actor = await requireActor();
  if (!can(actor, action, resource)) throw new Error("Forbidden");
  return actor;
}
