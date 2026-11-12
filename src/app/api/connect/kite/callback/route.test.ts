import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Route-level checks with access and the broker row mocked (the real single-use/expiry SQL is
// covered in connections.test.ts). The stand-in keeps the same contract: hash match, not
// expired, cleared on use.
const mem = vi.hoisted(() => ({
  owner: true,
  pending: null as null | { hash: string; verifier: string; exp: number },
}));
vi.mock("@/lib/auth/access", () => ({
  authorize: vi.fn(async () => {
    if (!mem.owner) throw new Error("Forbidden");
    return { kind: "owner" };
  }),
}));
vi.mock("@/lib/brokers/connections", () => ({
  consumeOAuthState: vi.fn(async (_b: string, hash: string) => {
    const p = mem.pending;
    if (!p || p.hash !== hash) return null;
    mem.pending = null;
    return p.exp > Date.now() ? p.verifier : null;
  }),
  loadMcpClientInfo: vi.fn(async () => ({ client_id: "cid", redirect_uris: [] })),
  saveMcpTokens: vi.fn(),
  setStatus: vi.fn(),
}));
const conn = await import("@/lib/brokers/connections");
const { GET } = await import("./route");

const STATE = "s".repeat(43);
const hash = (s: string) => createHash("sha256").update(s).digest("base64url");
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT = `${b64({ alg: "HS256" })}.${b64({ exp: 1_800_000_000 })}.sig`;

const callback = (q: Record<string, string>, cookie: string | null = STATE) =>
  GET(
    new NextRequest(`https://app.test/api/connect/kite/callback?${new URLSearchParams(q)}`, {
      headers: cookie ? { cookie: `kite_oauth_state=${cookie}` } : {},
    }),
  );

describe("GET /api/connect/kite/callback", () => {
  const fetchMock = vi.fn<(u: string | URL, init?: RequestInit) => Promise<Response>>(async () =>
    Response.json({ access_token: JWT, expires_in: 604799 }),
  );
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("APP_URL", "https://app.test");
    vi.stubGlobal("fetch", fetchMock);
    mem.owner = true;
    mem.pending = { hash: hash(STATE), verifier: "verifier-1", exp: Date.now() + 60_000 };
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("valid state → token stored, redirect to settings, cookie cleared", async () => {
    const res = await callback({ code: "c1", state: STATE });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://app.test/settings/brokers?kite=connected");
    expect(res.headers.get("set-cookie")).toMatch(/kite_oauth_state=;/);
    expect(conn.saveMcpTokens).toHaveBeenCalledWith("kite", { access_token: JWT }, new Date(1_800_000_000_000));
    expect(conn.setStatus).toHaveBeenCalledWith("kite", "connected");
    const body = new URLSearchParams(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.get("code_verifier")).toBe("verifier-1");
    expect(body.get("redirect_uri")).toBe("https://app.test/api/connect/kite/callback");
  });

  it.each([
    ["missing state", { code: "c1" }, STATE],
    ["missing code", { state: STATE }, STATE],
    ["missing binding cookie", { code: "c1", state: STATE }, null],
    ["state ≠ cookie", { code: "c1", state: "x".repeat(43) }, STATE],
    ["state not the stored one", { code: "c1", state: "x".repeat(43) }, "x".repeat(43)],
  ])("%s → 400, no token request or write", async (_n, q, cookie) => {
    const res = await callback(q, cookie);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(conn.saveMcpTokens).not.toHaveBeenCalled();
  });

  it("expired state → 400, nothing written", async () => {
    mem.pending!.exp = Date.now() - 1;
    expect((await callback({ code: "c1", state: STATE })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(conn.saveMcpTokens).not.toHaveBeenCalled();
  });

  it("state is single-use", async () => {
    expect((await callback({ code: "c1", state: STATE })).status).toBe(303);
    expect((await callback({ code: "c1", state: STATE })).status).toBe(400);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("non-owner → 403 before the state is touched", async () => {
    mem.owner = false;
    expect((await callback({ code: "c1", state: STATE })).status).toBe(403);
    expect(conn.consumeOAuthState).not.toHaveBeenCalled();
    expect(mem.pending).not.toBeNull();
  });

  it("token exchange failure → login_failed at token, redirect with failed notice", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "invalid_grant" }, { status: 400 }));
    const res = await callback({ code: "c1", state: STATE });
    expect(res.headers.get("location")).toBe("https://app.test/settings/brokers?kite=failed");
    expect(conn.setStatus).toHaveBeenCalledWith("kite", "login_failed", expect.objectContaining({ step: "token" }));
    expect(conn.saveMcpTokens).not.toHaveBeenCalled();
  });
});
