import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, pool } from "@/db";
import { accessGrants, shareLinks, user } from "@/db/schema";
import { actorForShareCookie } from "./access";
import { findGrant, userCreateGate } from "./grants";
import { hashToken, mintToken, signShareCookie } from "./share-link";

// Integration test against the real Neon DB. Uses unique emails/ids and deletes
// every row it creates. Skips when DATABASE_URL is absent (CI).
describe.skipIf(!process.env.DATABASE_URL)("auth gate + share links (Neon)", () => {
  const tag = randomUUID().slice(0, 8);
  const invited = `invited-${tag}@example.com`;
  const expired = `expired-${tag}@example.com`;
  const revoked = `revoked-${tag}@example.com`;
  const stranger = `stranger-${tag}@example.com`;
  const linkIds: string[] = [];

  beforeAll(async () => {
    vi.stubEnv("OWNER_EMAIL", `owner-${tag}@example.com`);
    vi.stubEnv("SHARE_LINK_SECRET", "s".repeat(44));
    const day = 86_400_000;
    await db.insert(accessGrants).values([
      { email: invited, role: "contributor", createdBy: "test", expiresAt: new Date(Date.now() + day) },
      { email: expired, role: "viewer", createdBy: "test", expiresAt: new Date(Date.now() - day) },
      { email: revoked, role: "viewer", createdBy: "test", revokedAt: new Date() },
    ]);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.delete(accessGrants).where(inArray(accessGrants.email, [invited, expired, revoked]));
    if (linkIds.length) await db.delete(shareLinks).where(inArray(shareLinks.id, linkIds));
    await pool.end();
  });

  describe("user.create.before gate", () => {
    it("uninvited email → throws NOT_INVITED", async () => {
      await expect(userCreateGate(stranger)).rejects.toMatchObject({ body: { code: "NOT_INVITED" } });
    });
    it("expired or revoked grant → throws ACCESS_EXPIRED", async () => {
      await expect(userCreateGate(expired)).rejects.toMatchObject({ body: { code: "ACCESS_EXPIRED" } });
      await expect(userCreateGate(revoked)).rejects.toMatchObject({ body: { code: "ACCESS_EXPIRED" } });
    });
    it("invited email passes, in any case", async () => {
      await expect(userCreateGate(invited)).resolves.toBeUndefined();
      await expect(userCreateGate(invited.toUpperCase())).resolves.toBeUndefined();
    });
    it("owner passes with no grant row, in any case", async () => {
      await expect(userCreateGate(`OWNER-${tag}@Example.com`)).resolves.toBeUndefined();
    });
    it("rejected emails never got a user row", async () => {
      const rows = await db.select().from(user).where(inArray(user.email, [stranger, expired, revoked]));
      expect(rows).toEqual([]);
    });
    it("DB rejects a non-lowercased grant email", async () => {
      const err = await db
        .insert(accessGrants)
        .values({ email: `Mixed-${tag}@Example.com`, role: "viewer", createdBy: "test" })
        .then(() => null, (e: unknown) => e);
      expect((err as { cause?: { code?: string } })?.cause?.code).toBe("23514");
    });
    it("findGrant is case-insensitive", async () => {
      expect((await findGrant(invited.toUpperCase()))?.role).toBe("contributor");
    });
  });

  describe("share-link cookie resolution", () => {
    async function mkLink(v: Partial<typeof shareLinks.$inferInsert> = {}) {
      const [row] = await db
        .insert(shareLinks)
        .values({ tokenHash: hashToken(mintToken()), ...v })
        .returning();
      linkIds.push(row.id);
      return row;
    }

    it("active link → viewer with its hide-amounts flag; last_used_at touched at most hourly", async () => {
      const link = await mkLink({ hideAmounts: true });
      const now = new Date();
      expect(await actorForShareCookie(signShareCookie(link.id), now)).toEqual({
        kind: "viewer",
        hideAmounts: true,
        via: "share-link",
      });
      const [a] = await db.select().from(shareLinks).where(eq(shareLinks.id, link.id));
      expect(a.lastUsedAt?.getTime()).toBe(now.getTime());

      await actorForShareCookie(signShareCookie(link.id), new Date(now.getTime() + 10 * 60_000));
      const [b] = await db.select().from(shareLinks).where(eq(shareLinks.id, link.id));
      expect(b.lastUsedAt?.getTime()).toBe(now.getTime()); // within the hour: untouched
    });

    it("revoked or expired link → no access", async () => {
      const r = await mkLink({ revokedAt: new Date() });
      const e = await mkLink({ expiresAt: new Date(Date.now() - 1000) });
      expect(await actorForShareCookie(signShareCookie(r.id))).toBeNull();
      expect(await actorForShareCookie(signShareCookie(e.id))).toBeNull();
    });

    it("invalid HMAC or unknown id → no access", async () => {
      const link = await mkLink();
      expect(await actorForShareCookie(`${link.id}.forged`)).toBeNull();
      expect(await actorForShareCookie(signShareCookie(randomUUID()))).toBeNull();
    });
  });
});
