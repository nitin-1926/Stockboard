import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { shareLinks } from "@/db/schema";
import { actorForShareLink } from "@/lib/auth/access";
import {
  hashToken,
  isWellFormedToken,
  SHARE_COOKIE,
  SHARE_COOKIE_MAX_AGE_S,
  signShareCookie,
} from "@/lib/auth/share-link";

// Visiting /s/<token>: hash it, look the link up, set the signed cookie, go to the app.
// Anything else (malformed, unknown, revoked, expired; requireActor sends dead-link
// visitors to /s/expired) clears the cookie and lands on the explanatory page.
export async function GET(req: Request, ctx: RouteContext<"/s/[token]">) {
  const { token } = await ctx.params;
  const jar = await cookies();
  const [link] = isWellFormedToken(token)
    ? await db.select().from(shareLinks).where(eq(shareLinks.tokenHash, hashToken(token)))
    : [];

  if (!link || !actorForShareLink(link)) {
    jar.delete(SHARE_COOKIE);
    return NextResponse.redirect(new URL("/s/invalid", req.url));
  }

  const untilExpiry = link.expiresAt ? Math.floor((link.expiresAt.getTime() - Date.now()) / 1000) : Infinity;
  jar.set(SHARE_COOKIE, signShareCookie(link.id), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.min(SHARE_COOKIE_MAX_AGE_S, untilExpiry),
  });
  return NextResponse.redirect(new URL("/", req.url));
}
