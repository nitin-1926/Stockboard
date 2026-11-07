import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, pool } from "@/db";
import { brokerConnections } from "@/db/schema";
import {
  consumeOAuthState,
  getConnection,
  kiteCredentialsReadable,
  loadKiteCredentials,
  loadMcpClientInfo,
  loadMcpTokens,
  publicConnectionView,
  saveMcpClientInfo,
  saveMcpTokens,
  saveOAuthState,
  setKiteCredentials,
  setStatus,
} from "./connections";

// Integration test against the real Neon DB; the 'kite'/'indmoney' rows are singletons,
// so snapshot them up front and restore them afterwards. Skips when DATABASE_URL is absent.
describe.skipIf(!process.env.DATABASE_URL)("broker connections (Neon)", () => {
  let snapshot: (typeof brokerConnections.$inferSelect)[] = [];
  const creds = { userId: "AB1234", password: "pw-Секрет-1", totpSecret: "JBSWY3DPEHPK3PXP" };
  const tokens = { access_token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig", refresh_token: "rt-123" };

  beforeAll(async () => {
    vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    snapshot = await db.select().from(brokerConnections);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.delete(brokerConnections);
    if (snapshot.length) await db.insert(brokerConnections).values(snapshot);
    await pool.end();
  });

  it("stores only v1 envelopes and decrypts them back", async () => {
    await setKiteCredentials(creds);
    await saveMcpTokens("kite", tokens, new Date("2026-11-12T00:30:00Z"));
    const { rows } = await pool.query(
      `select kite_user_id_enc, kite_password_enc, kite_totp_secret_enc, mcp_tokens_enc
         from broker_connections where broker = 'kite'`,
    );
    for (const v of Object.values(rows[0])) {
      expect(v).toMatch(/^v1:/);
      for (const plain of [creds.password, creds.totpSecret, tokens.refresh_token]) {
        expect(v).not.toContain(plain);
      }
    }
    expect(await loadKiteCredentials()).toEqual(creds);
    expect(await loadMcpTokens("kite")).toEqual(tokens);
  });

  it("rejects a plaintext secret at the DB level", async () => {
    const err = await db
      .update(brokerConnections)
      .set({ kitePasswordEnc: "plaintext" })
      .where(eq(brokerConnections.broker, "kite"))
      .then(() => null, (e: unknown) => e);
    expect((err as { cause?: { code?: string } })?.cause?.code).toBe("23514");
  });

  it("publicConnectionView exposes status only", async () => {
    const view = publicConnectionView(await getConnection("kite"));
    expect(Object.keys(view).sort()).toEqual(
      ["broker", "credentialsSet", "credentialsUpdatedAt", "lastErrorStep", "lastSyncAt", "status", "tokenExpiresAt"],
    );
    expect(view.credentialsSet).toBe(true);
    expect(view.tokenExpiresAt).toEqual(new Date("2026-11-12T00:30:00Z"));
    const json = JSON.stringify({ ...view, tokenExpiresAt: undefined });
    for (const leak of ["v1:", creds.userId, creds.password, creds.totpSecret, tokens.access_token]) {
      expect(json).not.toContain(leak);
    }
    expect(json).not.toMatch(/password|totp|token/i);
  });

  it("stores the DCR client info encrypted", async () => {
    await saveMcpClientInfo("kite", { client_id: "cid-123", redirect_uris: ["http://127.0.0.1:53682/callback"] });
    const { rows } = await pool.query(`select mcp_client_info_enc from broker_connections where broker = 'kite'`);
    expect(rows[0].mcp_client_info_enc).toMatch(/^v1:/);
    expect(rows[0].mcp_client_info_enc).not.toContain("cid-123");
    expect(await loadMcpClientInfo("kite")).toEqual({ client_id: "cid-123", redirect_uris: ["http://127.0.0.1:53682/callback"] });
  });

  it("OAuth state: single-use, hash must match, expired never honoured", async () => {
    const later = new Date(Date.now() + 60_000);
    await saveOAuthState("kite", "hash-a", "verifier-a", later);
    expect(await consumeOAuthState("kite", "hash-b")).toBeNull(); // mismatch keeps the pending state
    expect(await consumeOAuthState("kite", "hash-a")).toBe("verifier-a");
    expect(await consumeOAuthState("kite", "hash-a")).toBeNull(); // replay

    await saveOAuthState("kite", "hash-c", "verifier-c", new Date(Date.now() - 1000));
    expect(await consumeOAuthState("kite", "hash-c")).toBeNull();
    const { rows } = await pool.query(`select oauth_state_hash from broker_connections where broker = 'kite'`);
    expect(rows[0].oauth_state_hash).toBeNull(); // expired state is cleared
  });

  it("kiteCredentialsReadable: true under the saving key, false under another key", async () => {
    await setKiteCredentials(creds);
    expect(await kiteCredentialsReadable()).toBe(true);
    const key = process.env.ENCRYPTION_KEY ?? "";
    vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    try {
      expect(await kiteCredentialsReadable()).toBe(false);
      await expect(loadKiteCredentials()).rejects.toThrow(/authentication failed/);
    } finally {
      vi.stubEnv("ENCRYPTION_KEY", key);
    }
  });

  it("setStatus redacts a JWT in the stored error", async () => {
    await setStatus("indmoney", "login_failed", {
      error: `refresh failed for ${tokens.access_token}`,
      step: "refresh",
    });
    const row = await getConnection("indmoney");
    expect(row.status).toBe("login_failed");
    expect(row.lastErrorStep).toBe("refresh");
    expect(row.lastError).toContain("[redacted-jwt]");
    expect(row.lastError).not.toContain("eyJ");

    await setStatus("indmoney", "connected");
    expect((await getConnection("indmoney")).lastError).toBeNull();
  });
});
