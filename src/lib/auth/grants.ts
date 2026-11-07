// Grant lookup and the sign-up gate. Kept apart from access.ts so the Better Auth
// config can import the gate without an import cycle (access.ts imports the config).
import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { accessGrants } from "@/db/schema";

export type GrantRow = typeof accessGrants.$inferSelect;

/** Not revoked and not past expiry. Works for grants and share links. */
export const isActive = (
  row: { revokedAt: Date | null; expiresAt: Date | null },
  now = new Date(),
) => !row.revokedAt && (!row.expiresAt || row.expiresAt > now);

export const isOwnerEmail = (email: string) =>
  !!process.env.OWNER_EMAIL && email.toLowerCase() === process.env.OWNER_EMAIL.toLowerCase();

export async function findGrant(email: string): Promise<GrantRow | null> {
  const [row] = await db
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.email, email.toLowerCase()));
  return row ?? null;
}

/**
 * `databaseHooks.user.create.before`: only the owner or an actively invited email may
 * get a user row. Throwing an APIError aborts the insert; Better Auth redirects to the
 * sign-in page's errorCallbackURL with `?error=<code>`.
 */
export async function userCreateGate(email: string): Promise<void> {
  if (isOwnerEmail(email)) return;
  const grant = await findGrant(email);
  if (grant && isActive(grant)) return;
  throw new APIError("FORBIDDEN", {
    code: grant ? "ACCESS_EXPIRED" : "NOT_INVITED",
    message: grant ? "Access expired or revoked" : "Email not invited",
  });
}
