import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";
import { devBypassEmail } from "@/lib/auth/dev-bypass";
import { SHARE_COOKIE } from "@/lib/auth/share-link";

// Optimistic cookie-PRESENCE check only: it keeps anonymous visitors off app pages.
// It is not authorization. Roles, grants, revocation and link validity are resolved
// in the data-access layer (src/lib/auth/access.ts) on every view and action.
export function proxy(req: NextRequest) {
  if (getSessionCookie(req) || req.cookies.has(SHARE_COOKIE) || devBypassEmail()) return NextResponse.next();
  return NextResponse.redirect(new URL("/sign-in", req.url));
}

export const config = {
  // Public: auth + cron APIs, sign-in, share-link routes, Next assets, root files.
  matcher: ["/((?!api/|_next/|sign-in|s/|favicon\\.ico|.*\\.(?:svg|png|jpg|ico|webp|txt)$).*)"],
};
