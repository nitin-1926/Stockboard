// Kite MCP auth: a stored JWT (no refresh token exists), one DCR client registration,
// PKCE helpers and the code → token exchange shared by the headless and manual flows.
import { createHash, randomBytes } from "node:crypto";
import {
  loadMcpClientInfo,
  loadMcpTokens,
  saveMcpClientInfo,
  saveMcpTokens,
  setStatus,
} from "@/lib/brokers/connections";
import { SessionExpiredError, type ToolCaller, withMcp } from "../client";

export const KITE_MCP = "https://mcp.kite.trade";
/** MCP endpoint, also the OAuth `resource` (from /.well-known/oauth-protected-resource). */
export const KITE_MCP_URL = `${KITE_MCP}/mcp`;
/** Headless job's redirect_uri: never listened on, the chain stops at its Location. */
export const LOOPBACK_REDIRECT = "http://127.0.0.1:53682/callback";

/** Manual reconnect: binds the pending OAuth state to the browser (and owner session) that started it. */
export const STATE_COOKIE = "kite_oauth_state";
export const STATE_TTL_MS = 10 * 60 * 1000;

export function appCallback() {
  const app = process.env.APP_URL?.replace(/\/$/, "");
  if (!app) throw new Error("APP_URL is not set");
  return `${app}/api/connect/kite/callback`;
}

type KiteClient = { client_id: string; redirect_uris: string[] };

/**
 * One public-client registration carrying BOTH redirect URIs (U1: Kite accepts that), stored
 * encrypted. client_id is stateless and never expires, so re-register only if a URI is missing.
 */
export async function ensureKiteClient(): Promise<KiteClient> {
  const uris = [LOOPBACK_REDIRECT, appCallback()];
  // Unreadable under this environment's key (rotation, or a row written by another env):
  // the client_id is public and stateless, so registering again is the whole recovery.
  const stored = await loadMcpClientInfo<KiteClient>("kite").catch(() => null);
  if (stored && uris.every((u) => stored.redirect_uris?.includes(u))) return stored;
  const r = await fetch(`${KITE_MCP}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Stockboard", redirect_uris: uris }),
  });
  const body = (await r.json().catch(() => ({}))) as Partial<KiteClient>;
  if (!r.ok || !body.client_id) throw new Error(`Kite MCP client registration failed: HTTP ${r.status}`);
  const client = { client_id: body.client_id, redirect_uris: body.redirect_uris ?? uris };
  await saveMcpClientInfo("kite", client);
  return client;
}

export const b64url = (b: Buffer) => b.toString("base64url");
export const sha256 = (s: string) => createHash("sha256").update(s).digest("base64url");

/** PKCE verifier + state for one authorization request. */
export function newAuthRequest() {
  return { verifier: b64url(randomBytes(32)), state: b64url(randomBytes(32)) };
}

export function authorizeUrl(clientId: string, redirectUri: string, state: string, verifier: string) {
  const u = new URL(`${KITE_MCP}/authorize`);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: sha256(verifier),
    code_challenge_method: "S256",
    state,
    resource: KITE_MCP_URL,
  }).toString();
  return u;
}

const jwtExp = (jwt: string): number | undefined => {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).exp;
  } catch {
    return undefined;
  }
};

/** POST /token (PKCE, public client). Returns the JWT and its expiry. Errors carry no secrets. */
export async function exchangeCode(p: { code: string; verifier: string; clientId: string; redirectUri: string }) {
  const r = await fetch(`${KITE_MCP}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: p.code,
      code_verifier: p.verifier,
      client_id: p.clientId,
      redirect_uri: p.redirectUri,
      resource: KITE_MCP_URL,
    }).toString(),
  });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (r.status !== 200 || !j.access_token) throw new Error(`token exchange failed: HTTP ${r.status} ${j.error ?? ""}`);
  const exp = jwtExp(j.access_token) ?? Math.floor(Date.now() / 1000) + (j.expires_in ?? 0);
  return { accessToken: j.access_token, expiresAt: new Date(exp * 1000) };
}

/** Stores the JWT encrypted with its exp and marks Kite connected (clears the last error). */
export async function storeKiteToken(t: { accessToken: string; expiresAt: Date }) {
  await saveMcpTokens("kite", { access_token: t.accessToken }, t.expiresAt);
  await setStatus("kite", "connected");
}

async function kiteToken(): Promise<string> {
  const t = await loadMcpTokens<{ access_token: string }>("kite");
  if (!t?.access_token) throw new SessionExpiredError("no Kite token stored");
  const exp = jwtExp(t.access_token);
  if (exp && exp * 1000 <= Date.now()) throw new SessionExpiredError("Kite token expired");
  return t.access_token;
}

/**
 * Runs `fn` against the Kite MCP server with the stored JWT. A dead session marks the
 * connection stale (U10 re-logs in once and retries). The JWT can outlive the Kite session
 * (06:00 IST), so expiry is only known from the server's answer.
 */
export async function withKite<T>(fn: (call: ToolCaller) => Promise<T>): Promise<T> {
  try {
    const token = await kiteToken();
    return await withMcp(KITE_MCP_URL, async () => token, fn);
  } catch (e) {
    if (e instanceof SessionExpiredError) await setStatus("kite", "stale", { error: e.message, step: "session" });
    throw e;
  }
}
