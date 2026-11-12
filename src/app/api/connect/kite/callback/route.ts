import { timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/auth/access";
import { consumeOAuthState, loadMcpClientInfo, setStatus } from "@/lib/brokers/connections";
import { appCallback, exchangeCode, sha256, STATE_COOKIE, storeKiteToken } from "@/lib/mcp/kite/auth";

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// Kite redirects the owner's browser here with ?code&state. Requires the owner session,
// the binding cookie, and the stored single-use state hash before any token request.
export async function GET(req: NextRequest) {
  try {
    await authorize("manage");
  } catch (e) {
    if (e instanceof Error && e.message === "Forbidden") return new Response("Forbidden", { status: 403 });
    throw e;
  }
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const bound = req.cookies.get(STATE_COOKIE)?.value;
  if (!code || !state || !bound || !same(state, bound)) return new Response("Invalid OAuth state", { status: 400 });
  const verifier = await consumeOAuthState("kite", sha256(state));
  const client = verifier && (await loadMcpClientInfo<{ client_id: string }>("kite"));
  if (!verifier || !client) return new Response("Invalid or expired OAuth state", { status: 400 });

  let result = "connected";
  try {
    await storeKiteToken(await exchangeCode({ code, verifier, clientId: client.client_id, redirectUri: appCallback() }));
  } catch (e) {
    result = "failed";
    await setStatus("kite", "login_failed", { error: e instanceof Error ? e.message : String(e), step: "token" });
  }
  const res = NextResponse.redirect(new URL(`/settings/brokers?kite=${result}`, req.nextUrl), 303);
  res.cookies.delete({ name: STATE_COOKIE, path: "/api/connect/kite" });
  return res;
}
