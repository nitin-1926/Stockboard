// U1 spike (Kite only): one Zerodha web login → (B) Kite MCP OAuth chain + read tools, (C) Kite Connect
// Personal REST, sharing one cookie jar. Run: pnpm tsx scripts/spike/kite-headless.mts
// Safety: credentials load from .env.spike.local and never reach stdout or disk. Raw broker data goes to
// scripts/spike/out/ (gitignored, deleted after the spike); scripts/spike/scrub.ts turns it into fixtures.
// Exactly one /api/login + /api/twofa per run; no retries. Read-only tools/endpoints only.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { generate } from "otplib";

process.loadEnvFile(".env.spike.local");
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing ${k}`);
  return v;
};

const OUT = "scripts/spike/out";
mkdirSync(OUT, { recursive: true });
const save = (name: string, data: unknown) =>
  writeFileSync(`${OUT}/${name}`, typeof data === "string" ? data : JSON.stringify(data, null, 2));

const KITE = "https://kite.zerodha.com";
const MCP = "https://mcp.kite.trade";
const LOOPBACK = "http://127.0.0.1:53682/callback";
const REDIRECTS = [LOOPBACK, "https://stockboard.nitingupta.xyz/api/connect/kite/callback"];
const UA = "Mozilla/5.0";

// Secret-free findings, written to out/summary.json and printed.
const S: Record<string, unknown> = { ranAt: new Date().toISOString() };
const ms = (t: number) => Math.round(performance.now() - t);

class StepError extends Error {
  constructor(public step: string, public status: number, msg: string) {
    super(`${step} failed: HTTP ${status} ${msg}`);
  }
}

// ---------- cookie jar + manual-redirect HTTP ----------
type Cookie = { name: string; value: string; domain: string; hostOnly: boolean; path: string };
const jar: Cookie[] = [];
function storeCookies(url: URL, res: Response) {
  for (const sc of res.headers.getSetCookie()) {
    const [nv, ...attrs] = sc.split(";");
    const eq = nv.indexOf("=");
    const name = nv.slice(0, eq).trim();
    const value = nv.slice(eq + 1).trim();
    let domain = url.hostname;
    let hostOnly = true;
    let path = "/";
    let expired = false;
    for (const a of attrs) {
      const i = a.indexOf("=");
      const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase();
      const v = i < 0 ? "" : a.slice(i + 1).trim();
      if (k === "domain" && v) {
        domain = v.replace(/^\./, "").toLowerCase();
        hostOnly = false;
      }
      if (k === "path" && v) path = v;
      if (k === "max-age" && Number(v) <= 0) expired = true;
      if (k === "expires" && Date.parse(v) < Date.now()) expired = true;
    }
    const at = jar.findIndex((c) => c.name === name && c.domain === domain && c.path === path);
    if (at >= 0) jar.splice(at, 1);
    if (!expired) jar.push({ name, value, domain, hostOnly, path });
  }
}
function cookieHeader(url: URL) {
  const h = url.hostname;
  return jar
    .filter((c) => (c.hostOnly ? h === c.domain : h === c.domain || h.endsWith("." + c.domain)))
    .filter((c) => url.pathname.startsWith(c.path))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}
// host + path + query param NAMES only — never values.
const scrubUrl = (u: URL) => {
  const keys = [...u.searchParams.keys()];
  return `${u.host}${u.pathname}${keys.length ? "?" + keys.join("&") : ""}`;
};
type Hop = { step: string; method: string; url: string; status: number; setCookies: string[]; location?: string; ms: number };
const hops: Hop[] = [];
async function http(url: string | URL, init: RequestInit & { headers?: Record<string, string> }, step: string) {
  const u = new URL(url);
  const t = performance.now();
  const cookie = cookieHeader(u);
  const res = await fetch(u, {
    ...init,
    redirect: "manual",
    headers: { "User-Agent": UA, ...(cookie ? { Cookie: cookie } : {}), ...init.headers },
  });
  storeCookies(u, res);
  const loc = res.headers.get("location");
  hops.push({
    step,
    method: init.method ?? "GET",
    url: scrubUrl(u),
    status: res.status,
    setCookies: res.headers.getSetCookie().map((c) => c.split("=")[0]),
    ...(loc ? { location: scrubUrl(new URL(loc, u)) } : {}),
    ms: ms(t),
  });
  return res;
}
// Follow GET redirects until stop(url) — the stop URL itself is never requested.
async function follow(start: URL, stop: (u: URL) => boolean, step: string) {
  let u = start;
  for (let i = 0; i < 15; i++) {
    if (stop(u)) return { ok: true as const, url: u };
    const res = await http(u, {}, step);
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      u = new URL(loc, u);
      continue;
    }
    const body = await res.text();
    const title = /<title>([^<]*)<\/title>/i.exec(body)?.[1]?.trim();
    return { ok: false as const, stuckAt: scrubUrl(u), status: res.status, title, contentType: res.headers.get("content-type") };
  }
  return { ok: false as const, stuckAt: scrubUrl(u), status: 0, title: "too many redirects" };
}

// Replace leaves with type names (for responses whose values are login handles/tokens).
const shapeOf = (v: unknown): unknown =>
  Array.isArray(v) ? v.slice(0, 1).map(shapeOf) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x)]))
    : v === null ? null : typeof v;
const b64url = (b: Buffer) => b.toString("base64url");

// ---------- B1/B2a: Kite MCP DCR + consent (no credentials needed) ----------
let mcpLoginUrl: URL | undefined;
let pkce: { verifier: string; state: string; clientId: string; resource?: string } | undefined;
async function mcpConsent() {
  const t = performance.now();
  const prm = await (await fetch(`${MCP}/.well-known/oauth-protected-resource`)).json();
  const asm = await (await fetch(`${MCP}/.well-known/oauth-authorization-server`)).json();
  S.mcpMetadata = { protectedResource: prm, authorizationServer: asm };

  let clientId: string;
  const dcrFile = `${OUT}/dcr.json`; // client_id stays in out/ only
  if (existsSync(dcrFile)) {
    clientId = JSON.parse(readFileSync(dcrFile, "utf8")).client_id;
    S.dcr = { reused: true };
  } else {
    const reg = async (uris: string[]) => {
      const r = await fetch(`${MCP}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "Stockboard", redirect_uris: uris }),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    let r = await reg(REDIRECTS);
    const multi = { status: r.status, accepted: r.status < 300, error: r.body.error, redirect_uris: r.body.redirect_uris };
    if (r.status >= 300) r = await reg([LOOPBACK]);
    if (r.status >= 300) throw new StepError("dcr", r.status, r.body.error ?? "");
    clientId = r.body.client_id;
    save("dcr.json", r.body);
    S.dcr = { multiUri: multi, responseKeys: Object.keys(r.body), shape: shapeOf({ ...r.body, client_id: "x" }) };
  }

  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  const resource = typeof prm.resource === "string" ? prm.resource : undefined;
  const authz = new URL(`${MCP}/authorize`);
  authz.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: LOOPBACK,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    state,
    ...(resource ? { resource } : {}),
  }).toString();
  const r1 = await http(authz, {}, "mcp.authorize.get");
  const html = await r1.text();
  if (r1.status !== 200) throw new StepError("consent", r1.status, "GET /authorize not 200");
  const field = (n: string) => new RegExp(`name="${n}"\\s+value="([^"]+)"`).exec(html)?.[1];
  const flow = field("flow");
  const csrf = field("csrf");
  if (!flow || !csrf) throw new StepError("consent", r1.status, "flow/csrf not found in consent page");
  // Consent page fixture with every bound value replaced (csrf == consent cookie value).
  save("mcp-consent.html", html.replaceAll(flow, "FLOW_PLACEHOLDER").replaceAll(csrf, "CSRF_PLACEHOLDER").replaceAll(clientId, "CLIENT_ID_PLACEHOLDER"));

  const r2 = await http(
    `${MCP}/authorize`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ flow, csrf, decision: "approve" }).toString(),
    },
    "mcp.authorize.post",
  );
  const loc = r2.headers.get("location");
  if (r2.status !== 303 || !loc) throw new StepError("consent", r2.status, "POST /authorize did not 303");
  mcpLoginUrl = new URL(loc, MCP);
  pkce = { verifier, state, clientId, resource };
  S.mcpConsentMs = ms(t);
}

// ---------- A: Zerodha web login, exactly one attempt ----------
async function zerodhaLogin() {
  const t = performance.now();
  const userId = env("KITE_USER_ID");
  const form = { "Content-Type": "application/x-www-form-urlencoded", "X-Kite-Version": "3" };
  const r1 = await http(`${KITE}/api/login`, { method: "POST", headers: form, body: new URLSearchParams({ user_id: userId, password: env("KITE_PASSWORD") }).toString() }, "zerodha.api.login");
  const j1 = await r1.json().catch(() => ({}));
  save("zerodha-login.shape.json", shapeOf(j1));
  if (r1.status !== 200 || j1.status !== "success") throw new StepError("login", r1.status, j1.message ?? j1.error_type ?? "");
  S.login = { status: r1.status, twofa_type: j1.data?.twofa_type, twofa_types: j1.data?.twofa_types };

  const left = 30 - (Math.floor(Date.now() / 1000) % 30);
  if (left < 3) await new Promise((r) => setTimeout(r, (left + 0.5) * 1000));
  const code = await generate({ secret: env("KITE_TOTP_SECRET") });
  const r2 = await http(
    `${KITE}/api/twofa`,
    { method: "POST", headers: form, body: new URLSearchParams({ user_id: userId, request_id: j1.data.request_id, twofa_value: code, twofa_type: "totp" }).toString() },
    "zerodha.api.twofa",
  );
  const j2 = await r2.json().catch(() => ({}));
  save("zerodha-twofa.shape.json", shapeOf(j2));
  if (r2.status !== 200 || j2.status !== "success") throw new StepError("twofa", r2.status, j2.message ?? j2.error_type ?? "");
  S.twofa = { status: r2.status, waitedForWindow: left < 3 };
  S.zerodhaLoginMs = ms(t);
}

// ---------- B2b-B4: finish MCP chain, token, tool calls ----------
const READ_CALLS = new Set(["portfolio:profile", "portfolio:margins", "portfolio:holdings", "portfolio:positions", "orders:list", "orders:all_trades", "orders:trades", "orders:history", "market:ltp"]);
async function mcpFinish() {
  if (!mcpLoginUrl || !pkce) return;
  const t = performance.now();
  const f = await follow(mcpLoginUrl, (u) => u.hostname === "127.0.0.1", "mcp.kite.redirects");
  if (!f.ok) throw new StepError("redirect", f.status, `stuck at ${f.stuckAt} title=${f.title}`);
  const code = f.url.searchParams.get("code");
  S.mcpCallback = { stateMatches: f.url.searchParams.get("state") === pkce.state, hasCode: !!code, params: [...f.url.searchParams.keys()] };
  if (!code) throw new StepError("redirect", 0, "no code on loopback redirect");

  const tr = await http(
    `${MCP}/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: pkce.verifier,
        client_id: pkce.clientId,
        redirect_uri: LOOPBACK,
        ...(pkce.resource ? { resource: pkce.resource } : {}),
      }).toString(),
    },
    "mcp.token",
  );
  const tj = await tr.json().catch(() => ({}));
  if (tr.status !== 200 || !tj.access_token) throw new StepError("token", tr.status, tj.error ?? "");
  const jwt: string = tj.access_token;
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
  S.mcpToken = {
    responseKeys: Object.keys(tj),
    token_type: tj.token_type,
    scope: tj.scope,
    expires_in: tj.expires_in,
    claimNames: Object.keys(claims),
    iat: claims.iat && new Date(claims.iat * 1000).toISOString(),
    exp: claims.exp && new Date(claims.exp * 1000).toISOString(),
    lifetimeHours: claims.exp && claims.iat ? +((claims.exp - claims.iat) / 3600).toFixed(2) : undefined,
  };
  S.mcpChainMs = ms(t);

  // Connect: try the stateless 2026-07-28 negotiation first, then legacy.
  const connect = async (auto: boolean) => {
    const c = new Client({ name: "stockboard-spike", version: "0.0.0" }, auto ? { versionNegotiation: { mode: "auto" } } : {});
    const tc = performance.now();
    await c.connect(new StreamableHTTPClientTransport(new URL(`${MCP}/mcp`), { authProvider: { token: async () => jwt } }));
    return { c, connectMs: ms(tc) };
  };
  let client: Client;
  try {
    const { c, connectMs } = await connect(true);
    client = c;
    S.mcpConnect = { mode: "auto", connectMs };
  } catch (e) {
    S.mcpConnectAutoError = (e as Error).message.slice(0, 200);
    const { c, connectMs } = await connect(false);
    client = c;
    S.mcpConnect = { mode: "legacy", connectMs };
  }
  try {
    Object.assign(S.mcpConnect as object, {
      protocolVersion: client.getNegotiatedProtocolVersion(),
      serverVersion: client.getServerVersion(),
      capabilities: client.getServerCapabilities(),
    });
    const tl = performance.now();
    const tools = await client.listTools();
    S.listToolsMs = ms(tl);
    save("mcp-tools-list.json", tools);
    S.tools = tools.tools.map((x) => ({
      name: x.name,
      modes: (x.inputSchema.properties?.mode as { enum?: string[] } | undefined)?.enum,
      hasOutputSchema: !!x.outputSchema,
      annotations: x.annotations,
    }));

    const calls: Record<string, unknown> = {};
    const call = async (label: string, name: string, args: Record<string, unknown>) => {
      if (!READ_CALLS.has(`${name}:${args.mode}`) && label !== "error-probe") throw new Error(`blocked non-read call ${name}:${args.mode}`);
      const tc = performance.now();
      try {
        const r = await client.callTool({ name, arguments: args });
        save(`mcp-${label}.json`, r);
        const sc = r.structuredContent as Record<string, unknown> | undefined;
        calls[label] = {
          ms: ms(tc),
          isError: !!r.isError,
          hasStructuredContent: !!sc,
          structuredKeys: sc && Object.keys(sc),
          pagination: sc?.pagination,
          contentTypes: (r.content as { type: string }[]).map((c) => c.type),
          errorText: r.isError ? (r.content as { text?: string }[])[0]?.text?.slice(0, 200) : undefined,
        };
        return r;
      } catch (e) {
        calls[label] = { ms: ms(tc), thrown: (e as Error).message.slice(0, 200) };
      }
    };
    await call("portfolio-profile", "portfolio", { mode: "profile" });
    await call("portfolio-margins", "portfolio", { mode: "margins" });
    const h = await call("portfolio-holdings", "portfolio", { mode: "holdings", type: "full", limit: 500 });
    await call("portfolio-holdings-page1", "portfolio", { mode: "holdings", type: "full", from: 0, limit: 2 });
    await call("portfolio-holdings-page2", "portfolio", { mode: "holdings", type: "full", from: 2, limit: 2 });
    await call("portfolio-positions", "portfolio", { mode: "positions", limit: 500 });
    const ol = await call("orders-list", "orders", { mode: "list" });
    await call("orders-all_trades", "orders", { mode: "all_trades" });
    const firstOrder = ((ol?.structuredContent as { data?: { order_id?: string }[] } | undefined)?.data ?? [])[0]?.order_id;
    if (firstOrder) await call("orders-trades", "orders", { mode: "trades", order_id: firstOrder });
    const held = ((h?.structuredContent as { data?: { exchange: string; tradingsymbol: string }[] } | undefined)?.data ?? [])[0];
    await call("market-ltp", "market", { mode: "ltp", instruments: ["NSE:NIFTYBEES", ...(held ? [`${held.exchange}:${held.tradingsymbol}`] : [])] });
    await call("error-probe", "market", { mode: "ltp" }); // missing instruments → expect isError
    S.mcpCalls = calls;
  } finally {
    await client.close();
  }
}

// ---------- C: Kite Connect Personal (owner's app), same jar ----------
async function kiteConnect() {
  const apiKey = env("KITE_API_KEY");
  const t = performance.now();
  const f = await follow(new URL(`${KITE}/connect/login?v=3&api_key=${apiKey}`), (u) => u.searchParams.has("request_token"), "connect.redirects");
  if (!f.ok) throw new StepError("connect-redirect", f.status, `stuck at ${f.stuckAt} title=${f.title}`);
  S.connectRedirect = { finalHost: f.url.host, finalPath: f.url.pathname, params: [...f.url.searchParams.keys()] };
  const requestToken = f.url.searchParams.get("request_token")!;
  const checksum = createHash("sha256").update(apiKey + requestToken + env("KITE_API_SECRET")).digest("hex");
  const r = await fetch("https://api.kite.trade/session/token", {
    method: "POST",
    headers: { "X-Kite-Version": "3", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ api_key: apiKey, request_token: requestToken, checksum }).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status !== 200 || !j.data?.access_token) throw new StepError("connect-token", r.status, j.error_type ?? j.message ?? "");
  const accessToken: string = j.data.access_token;
  const TOKENS = ["access_token", "public_token", "refresh_token", "enctoken", "api_key"];
  save("connect-session.json", { ...j, data: Object.fromEntries(Object.entries(j.data).filter(([k]) => !TOKENS.includes(k))) });
  S.connectSession = { status: r.status, dataKeys: Object.keys(j.data), loginTime: j.data.login_time };
  S.connectChainMs = ms(t);

  const rest: Record<string, unknown> = {};
  for (const [label, path] of [
    ["profile", "/user/profile"],
    ["holdings", "/portfolio/holdings"],
    ["positions", "/portfolio/positions"],
    ["margins", "/user/margins"],
    ["trades", "/trades"],
    ["orders", "/orders"],
    ["quote-ltp", "/quote/ltp?i=NSE:NIFTYBEES"],
  ]) {
    const tc = performance.now();
    const rr = await fetch(`https://api.kite.trade${path}`, { headers: { "X-Kite-Version": "3", Authorization: `token ${apiKey}:${accessToken}` } });
    const body = await rr.json().catch(() => ({}));
    save(`connect-${label}.json`, body);
    rest[label] = { status: rr.status, ms: ms(tc), ok: body.status === "success", error_type: body.error_type, message: body.status === "error" ? String(body.message).slice(0, 160) : undefined };
  }
  S.connectRest = rest;
}

// ---------- run ----------
const run = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    (S.steps as Record<string, string>)[name] = "pass";
    return true;
  } catch (e) {
    (S.steps as Record<string, string>)[name] = e instanceof StepError ? `FAIL ${e.message}` : `FAIL ${(e as Error).name}: ${(e as Error).message.slice(0, 200)}`;
    return false;
  }
};
S.steps = {};
await run("B.consent", mcpConsent);
// SPIKE_DRY=1: consent only + offline TOTP sanity, no Zerodha request.
if (process.env.SPIKE_DRY) {
  const c = await generate({ secret: env("KITE_TOTP_SECRET") });
  S.totpSanity = /^\d{6}$/.test(c);
} else if (await run("A.zerodhaLogin", zerodhaLogin)) {
  await run("B.mcpChainAndTools", mcpFinish);
  await run("C.kiteConnect", kiteConnect);
}
S.hops = hops;
save("summary.json", S);
console.log(JSON.stringify({ steps: S.steps, hops: hops.map((h) => `${h.step} ${h.method} ${h.url} → ${h.status}${h.location ? " → " + h.location : ""}`) }, null, 2));
