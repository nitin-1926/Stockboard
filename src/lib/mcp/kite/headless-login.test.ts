import { readFileSync } from "node:fs";
import { generate } from "otplib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import chain from "./__fixtures__/headless-chain.json";

// The recorded U1 chain (hosts, paths, statuses, cookie names, Location param names) drives a
// fake fetch; only values are invented. DB access is an in-memory stand-in.
const consentHtml = readFileSync(new URL("./__fixtures__/mcp-consent.html", import.meta.url), "utf8");
const CREDS = { userId: "AB1234", password: "pw-not-real", totpSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP" };
const LOOPBACK = "http://127.0.0.1:53682/callback";

const store = vi.hoisted(() => ({
  creds: null as null | { userId: string; password: string; totpSecret: string },
}));
vi.mock("@/lib/brokers/connections", () => ({
  loadKiteCredentials: vi.fn(async () => store.creds),
  loadMcpClientInfo: vi.fn(async () => ({
    client_id: "cid",
    redirect_uris: ["http://127.0.0.1:53682/callback", "https://app.test/api/connect/kite/callback"],
  })),
  saveMcpClientInfo: vi.fn(),
  saveMcpTokens: vi.fn(),
  setStatus: vi.fn(),
}));
const conn = await import("@/lib/brokers/connections");
const { kiteHeadlessLogin, KiteLoginError } = await import("./headless-login");

const EXP = 1_800_000_000;
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT = `${b64({ alg: "HS256" })}.${b64({ exp: EXP, iat: EXP - 604800 })}.sig`;

type Req = { method: string; url: URL; headers: Record<string, string>; body?: string };
type Handler = (r: Req) => Response;

function server(overrides: Record<string, Handler> = {}) {
  const reqs: Req[] = [];
  let state = "";
  const fill = (loc: string) => {
    const [hostPath, q] = loc.split("?");
    const u = new URL(`${hostPath.startsWith("127.0.0.1") ? "http" : "https"}://${hostPath}`);
    for (const k of q?.split("&") ?? []) u.searchParams.set(k, k === "state" ? state : k === "code" ? "the-code" : "x");
    return u.toString();
  };
  // Generic answer from the recorded hop for this method + host/path (MCP chain hops first).
  const recorded: Handler = (r) => {
    const key = `${r.url.host}${r.url.pathname}`;
    const hops = [...chain.hops].sort((a, b) => Number(a.step.startsWith("connect.")) - Number(b.step.startsWith("connect.")));
    const hop = hops.find((h) => h.method === r.method && h.url.split("?")[0] === key);
    if (!hop) throw new Error(`no recorded hop for ${r.method} ${key}`);
    const headers = new Headers();
    for (const n of hop.setCookies) headers.append("set-cookie", `${n.replace("<flow>", "FLOW_PLACEHOLDER")}=v; Path=/`);
    if (hop.location) headers.set("location", fill(hop.location));
    let body: string | null = null;
    if (hop.step === "mcp.authorize.get") body = consentHtml;
    if (hop.step === "zerodha.api.login") body = JSON.stringify({ status: "success", data: { request_id: "rid", twofa_type: "totp" } });
    if (hop.step === "zerodha.api.twofa") body = JSON.stringify({ status: "success", data: { profile: {} } });
    if (hop.step === "mcp.token") body = JSON.stringify({ access_token: JWT, expires_in: 604799, scope: "default", token_type: "Bearer" });
    if (hop.step === "connect.redirects") body = "<title>Login to Kite by Zerodha</title>";
    return new Response(body, { status: hop.status, headers });
  };
  const fetch = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(input);
    const r: Req = { method: init.method ?? "GET", url, headers: (init.headers ?? {}) as Record<string, string>, body: init.body as string };
    reqs.push(r);
    if (r.method === "GET" && url.pathname === "/authorize") state = url.searchParams.get("state") ?? "";
    return (overrides[`${r.method} ${url.host}${url.pathname}`] ?? recorded)(r);
  });
  vi.stubGlobal("fetch", fetch);
  const sent = (method: string, hostPath: string) => reqs.filter((r) => r.method === method && `${r.url.host}${r.url.pathname}` === hostPath);
  return { reqs, sent, fill };
}

const failure = () => vi.mocked(conn.setStatus).mock.calls.find((c) => c[1] === "login_failed");

describe("kiteHeadlessLogin (recorded chain)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("APP_URL", "https://app.test");
    store.creds = { ...CREDS };
    // Mid TOTP window: no guard wait.
    vi.useFakeTimers({ now: 1_800_000_015_000, toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("happy path: code from the loopback Location, PKCE token exchange, JWT stored with exp", async () => {
    const s = server();
    await expect(kiteHeadlessLogin()).resolves.toEqual({ expiresAt: new Date(EXP * 1000) });

    expect(conn.saveMcpTokens).toHaveBeenCalledWith("kite", { access_token: JWT }, new Date(EXP * 1000));
    expect(conn.setStatus).toHaveBeenCalledWith("kite", "connected");
    expect(failure()).toBeUndefined();
    expect(s.sent("POST", "kite.zerodha.com/api/login")).toHaveLength(1);
    expect(s.sent("POST", "kite.zerodha.com/api/twofa")).toHaveLength(1);
    expect(s.reqs.some((r) => r.url.hostname === "127.0.0.1")).toBe(false); // loopback never requested

    // Consent POST carried the consent cookie and the form's flow/csrf.
    const [consent] = s.sent("POST", "mcp.kite.trade/authorize");
    expect(consent.headers.Cookie).toContain("__Host-kite-consent-FLOW_PLACEHOLDER=v");
    expect(new URLSearchParams(consent.body)).toEqual(new URLSearchParams({ flow: "FLOW_PLACEHOLDER", csrf: "CSRF_PLACEHOLDER", decision: "approve" }));
    // Same jar across hosts: the Zerodha session cookies reach /connect/login.
    expect(s.sent("GET", "kite.zerodha.com/connect/login")[0].headers.Cookie).toContain("enctoken=v");

    const token = new URLSearchParams(s.sent("POST", "mcp.kite.trade/token")[0].body);
    expect(token.get("code")).toBe("the-code");
    expect(token.get("redirect_uri")).toBe(LOOPBACK);
    expect(token.get("client_id")).toBe("cid");
    const authz = s.sent("GET", "mcp.kite.trade/authorize")[0].url.searchParams;
    expect(authz.get("redirect_uri")).toBe(LOOPBACK);
    expect(authz.get("code_challenge")).toBe(
      (await import("node:crypto")).createHash("sha256").update(token.get("code_verifier")!).digest("base64url"),
    );
  });

  it("login error → login_failed at login, no twofa", async () => {
    const s = server({
      "POST kite.zerodha.com/api/login": () =>
        Response.json({ status: "error", message: "Invalid `user_id` or `password`.", error_type: "InputException" }, { status: 400 }),
    });
    const e = await kiteHeadlessLogin().catch((x) => x);
    expect(e).toBeInstanceOf(KiteLoginError);
    expect(e.step).toBe("login");
    expect(s.sent("POST", "kite.zerodha.com/api/twofa")).toHaveLength(0);
    const [, status, o] = failure()!;
    expect(status).toBe("login_failed");
    expect(o).toMatchObject({ step: "login" });
    expect(o?.error).not.toContain(CREDS.password);
  });

  it("twofa rejected → login_failed at twofa, exactly one attempt, chain stops", async () => {
    const s = server({
      "POST kite.zerodha.com/api/twofa": () => Response.json({ status: "error", message: "Invalid TOTP" }, { status: 400 }),
    });
    await expect(kiteHeadlessLogin()).rejects.toMatchObject({ step: "twofa" });
    expect(s.sent("POST", "kite.zerodha.com/api/twofa")).toHaveLength(1);
    expect(s.sent("POST", "kite.zerodha.com/api/login")).toHaveLength(1);
    expect(s.reqs.at(-1)?.url.pathname).toBe("/api/twofa");
    expect(failure()?.[2]).toMatchObject({ step: "twofa" });
    expect(conn.saveMcpTokens).not.toHaveBeenCalled();
  });

  it("chain stuck at Kite's connect/authorize page → authorize_app with a hint, no token call", async () => {
    const s = server({
      "GET kite.zerodha.com/connect/finish": () =>
        new Response(null, { status: 302, headers: { location: s.fill("kite.zerodha.com/connect/authorize?api_key&sess_id") } }),
    });
    await expect(kiteHeadlessLogin()).rejects.toMatchObject({ step: "authorize_app" });
    expect(failure()?.[2]?.error).toMatch(/Reconnect Kite/);
    expect(s.sent("POST", "mcp.kite.trade/token")).toHaveLength(0);
  });

  it("an extra redirect hop still reaches the loopback", async () => {
    const s = server({
      "GET mcp.kite.trade/callback": () =>
        new Response(null, { status: 302, headers: { location: "https://mcp.kite.trade/extra-hop" } }),
      "GET mcp.kite.trade/extra-hop": () =>
        new Response(null, { status: 302, headers: { location: s.fill("127.0.0.1:53682/callback?code&state") } }),
    });
    await expect(kiteHeadlessLogin()).resolves.toEqual({ expiresAt: new Date(EXP * 1000) });
    expect(s.sent("GET", "mcp.kite.trade/extra-hop")).toHaveLength(1);
  });

  it("state mismatch on the loopback → redirect step, no token call", async () => {
    const s = server({
      "GET mcp.kite.trade/callback": () =>
        new Response(null, { status: 302, headers: { location: `${LOOPBACK}?code=c&state=forged` } }),
    });
    await expect(kiteHeadlessLogin()).rejects.toMatchObject({ step: "redirect" });
    expect(s.sent("POST", "mcp.kite.trade/token")).toHaveLength(0);
  });

  it("no stored credentials → login_failed at login, nothing sent", async () => {
    store.creds = null;
    const s = server();
    await expect(kiteHeadlessLogin()).rejects.toMatchObject({ step: "login" });
    expect(s.reqs).toHaveLength(0);
  });

  it("TOTP window guard: near the edge, the code is generated after waiting for the next window", async () => {
    vi.useRealTimers();
    const edge = 1_800_000_000; // seconds, a multiple of 30
    vi.useFakeTimers({ now: (edge - 1) * 1000 }); // 1 s left in the window
    const s = server();
    const p = kiteHeadlessLogin();
    await vi.advanceTimersByTimeAsync(3000);
    await p;
    const sentCode = new URLSearchParams(s.sent("POST", "kite.zerodha.com/api/twofa")[0].body).get("twofa_value");
    expect(sentCode).toBe(await generate({ secret: CREDS.totpSecret, epoch: edge + 1 }));
    expect(sentCode).not.toBe(await generate({ secret: CREDS.totpSecret, epoch: edge - 1 }));
  });
});
