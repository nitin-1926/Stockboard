import { NextResponse } from "next/server";
import { authorize } from "@/lib/auth/access";
import { saveOAuthState } from "@/lib/brokers/connections";
import {
  appCallback,
  authorizeUrl,
  ensureKiteClient,
  newAuthRequest,
  sha256,
  STATE_COOKIE,
  STATE_TTL_MS,
} from "@/lib/mcp/kite/auth";

// Manual "Reconnect Kite" (owner only): the owner logs in to Kite in their own browser.
// State: 32 random bytes; only its hash is stored (single-use, 10 min), and the raw value
// rides in an httpOnly cookie so the callback only accepts the browser that started it.
export async function POST() {
  try {
    await authorize("manage");
  } catch (e) {
    if (e instanceof Error && e.message === "Forbidden") return new Response("Forbidden", { status: 403 });
    throw e; // signed out → redirect to /sign-in
  }
  const client = await ensureKiteClient();
  const { state, verifier } = newAuthRequest();
  await saveOAuthState("kite", sha256(state), verifier, new Date(Date.now() + STATE_TTL_MS));
  const res = NextResponse.redirect(authorizeUrl(client.client_id, appCallback(), state, verifier), 303);
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax", // sent on Kite's top-level redirect back to us
    path: "/api/connect/kite",
    maxAge: STATE_TTL_MS / 1000,
  });
  return res;
}
