// Daily headless Kite MCP login (U7), the U1 spike chain as one function:
//   consent GET/POST mcp.kite.trade/authorize → Zerodha /api/login → /api/twofa (TOTP)
//   → follow redirects by hand (one cookie jar) → read code off the loopback Location → /token.
// Exactly ONE Zerodha login attempt per call and no retries anywhere: a bad TOTP must not
// lock the account. Credentials come from the DB (encrypted) and are decrypted only here.
// Nothing here logs; errors carry step names, HTTP status and Zerodha's message, never values.
import { generate } from "otplib";
import { loadKiteCredentials, setStatus } from "@/lib/brokers/connections";
import { authorizeUrl, ensureKiteClient, exchangeCode, KITE_MCP, LOOPBACK_REDIRECT, newAuthRequest, storeKiteToken } from "./auth";

const KITE = "https://kite.zerodha.com";
const UA = "Mozilla/5.0";

export type LoginStep = "consent" | "login" | "twofa" | "redirect" | "authorize_app" | "token";

export class KiteLoginError extends Error {
  override name = "KiteLoginError";
  constructor(
    public step: LoginStep,
    message: string,
  ) {
    super(`kite login failed at ${step}: ${message}`);
  }
}

// ---------- cookie jar + manual-redirect fetch (per run) ----------
type Cookie = { name: string; value: string; domain: string; hostOnly: boolean; path: string };

function browser() {
  const jar: Cookie[] = [];
  function store(url: URL, res: Response) {
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
  function header(url: URL) {
    const h = url.hostname;
    return jar
      .filter((c) => (c.hostOnly ? h === c.domain : h === c.domain || h.endsWith("." + c.domain)))
      .filter((c) => url.pathname.startsWith(c.path))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }
  return async function http(url: string | URL, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
    const u = new URL(url);
    const cookie = header(u);
    const res = await fetch(u, {
      ...init,
      redirect: "manual",
      headers: { "User-Agent": UA, ...(cookie ? { Cookie: cookie } : {}), ...init.headers },
    });
    store(u, res);
    return res;
  };
}

/** Host + path only, for error messages (query values can be tokens). */
const where = (u: URL) => `${u.host}${u.pathname}`;
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };

/** Seconds left in the current 30 s TOTP window; within 2 s of the edge, wait for the next one. */
async function totpWindowGuard() {
  const left = 30 - ((Date.now() / 1000) % 30);
  if (left <= 2) await new Promise((r) => setTimeout(r, Math.ceil((left + 0.5) * 1000)));
}

async function run() {
  const creds = await loadKiteCredentials();
  if (!creds) throw new KiteLoginError("login", "Kite credentials are not set (Settings → Brokers)");
  const http = browser();
  const step = async <T>(name: LoginStep, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      throw e instanceof KiteLoginError ? e : new KiteLoginError(name, e instanceof Error ? e.message : String(e));
    }
  };

  // 1. MCP consent (needs no credentials). The consent/state cookies live 600 s.
  const auth = newAuthRequest();
  const { kiteLogin, clientId } = await step("consent", async () => {
    const client = await ensureKiteClient();
    const r1 = await http(authorizeUrl(client.client_id, LOOPBACK_REDIRECT, auth.state, auth.verifier));
    const html = await r1.text();
    if (r1.status !== 200) throw new KiteLoginError("consent", `GET /authorize HTTP ${r1.status}`);
    const field = (n: string) => new RegExp(`name="${n}"\\s+value="([^"]+)"`).exec(html)?.[1];
    const flow = field("flow");
    const csrf = field("csrf");
    if (!flow || !csrf) throw new KiteLoginError("consent", "flow/csrf not found on the consent page");
    const r2 = await http(`${KITE_MCP}/authorize`, {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({ flow, csrf, decision: "approve" }).toString(),
    });
    const loc = r2.headers.get("location");
    if (r2.status !== 303 || !loc) throw new KiteLoginError("consent", `POST /authorize HTTP ${r2.status}, expected 303`);
    return { kiteLogin: new URL(loc, KITE_MCP), clientId: client.client_id };
  });

  // 2. Zerodha web login: one attempt.
  const kiteForm = { ...FORM, "X-Kite-Version": "3" };
  const requestId = await step("login", async () => {
    const r = await http(`${KITE}/api/login`, {
      method: "POST",
      headers: kiteForm,
      body: new URLSearchParams({ user_id: creds.userId, password: creds.password }).toString(),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status !== 200 || j.status !== "success" || !j.data?.request_id) {
      throw new KiteLoginError("login", `HTTP ${r.status} ${j.message ?? j.error_type ?? ""}`.trim());
    }
    return j.data.request_id as string;
  });

  // 3. TOTP, generated right before the POST (after the window guard). No retry.
  await step("twofa", async () => {
    await totpWindowGuard();
    const code = await generate({ secret: creds.totpSecret });
    const r = await http(`${KITE}/api/twofa`, {
      method: "POST",
      headers: kiteForm,
      body: new URLSearchParams({ user_id: creds.userId, request_id: requestId, twofa_value: code, twofa_type: "totp" }).toString(),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status !== 200 || j.status !== "success") {
      throw new KiteLoginError("twofa", `HTTP ${r.status} ${j.message ?? j.error_type ?? ""}`.trim());
    }
  });

  // 4. Follow GET redirects until our loopback Location (never requested).
  const code = await step("redirect", async () => {
    const loopback = new URL(LOOPBACK_REDIRECT);
    let u = kiteLogin;
    for (let i = 0; i < 15; i++) {
      if (u.origin === loopback.origin && u.pathname === loopback.pathname) {
        if (u.searchParams.get("state") !== auth.state) throw new KiteLoginError("redirect", "state mismatch on the callback");
        const c = u.searchParams.get("code");
        if (!c) throw new KiteLoginError("redirect", `no code on the callback (${u.searchParams.get("error") ?? "no error"})`);
        return c;
      }
      const res = await http(u);
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        u = new URL(loc, u);
        continue;
      }
      if (u.hostname === "kite.zerodha.com" && u.pathname.startsWith("/connect/authorize")) {
        throw new KiteLoginError(
          "authorize_app",
          "Kite shows its one-time 'authorize app' screen; use Reconnect Kite once in a browser",
        );
      }
      throw new KiteLoginError("redirect", `stuck at ${where(u)} (HTTP ${res.status})`);
    }
    throw new KiteLoginError("redirect", "too many redirects");
  });

  // 5. Code → JWT, stored encrypted with its exp; status connected.
  return step("token", async () => {
    const t = await exchangeCode({ code, verifier: auth.verifier, clientId, redirectUri: LOOPBACK_REDIRECT });
    await storeKiteToken(t);
    return { expiresAt: t.expiresAt };
  });
}

/** One headless login. On failure: status `login_failed` with the step (error redacted), then rethrows. */
export async function kiteHeadlessLogin(): Promise<{ expiresAt: Date }> {
  try {
    return await run();
  } catch (e) {
    const err = e instanceof KiteLoginError ? e : new KiteLoginError("login", e instanceof Error ? e.message : String(e));
    await setStatus("kite", "login_failed", { error: err.message, step: err.step });
    throw err;
  }
}
