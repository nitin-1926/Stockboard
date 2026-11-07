// Server-only: decrypts broker secrets. `server-only` is not a dependency, so this
// is a convention: never import this module from a client component.
// No auth here; callers (settings actions, MCP and job code) enforce the owner check.
import { timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { brokerConnections, type brokerEnum, type brokerStatusEnum } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secrets";
import { redact } from "@/lib/jobs/handler";

export type Broker = (typeof brokerEnum.enumValues)[number];
export type BrokerStatus = (typeof brokerStatusEnum.enumValues)[number];
export type KiteCredentials = { userId: string; password: string; totpSecret: string };

type Row = typeof brokerConnections.$inferInsert;

// Insert-or-update the singleton row for a broker.
async function upsert(broker: Broker, set: Omit<Row, "broker">) {
  const values = { ...set, updatedAt: new Date() };
  await db
    .insert(brokerConnections)
    .values({ broker, ...values })
    .onConflictDoUpdate({ target: brokerConnections.broker, set: values });
}

/** Status fields only; never selects or decrypts a secret column. */
export async function getConnection(broker: Broker) {
  const c = brokerConnections;
  const [row] = await db
    .select({
      broker: c.broker,
      status: c.status,
      lastSyncAt: c.lastSyncAt,
      lastError: c.lastError,
      lastErrorStep: c.lastErrorStep,
      tokenExpiresAt: c.tokenExpiresAt,
      credentialsUpdatedAt: c.credentialsUpdatedAt,
      // Kite: the three login secrets. INDmoney: an OAuth token set.
      credentialsSet: sql<boolean>`case when ${c.broker} = 'kite'
        then ${c.kiteUserIdEnc} is not null and ${c.kitePasswordEnc} is not null and ${c.kiteTotpSecretEnc} is not null
        else ${c.mcpTokensEnc} is not null end`,
    })
    .from(c)
    .where(eq(c.broker, broker));
  return (
    row ?? {
      broker,
      status: "disconnected" as const,
      lastSyncAt: null,
      lastError: null,
      lastErrorStep: null,
      tokenExpiresAt: null,
      credentialsUpdatedAt: null,
      credentialsSet: false,
    }
  );
}

export type ConnectionStatus = Awaited<ReturnType<typeof getConnection>>;

/** The only shape the UI may receive. Picks fields explicitly so new columns never leak. */
export function publicConnectionView(row: ConnectionStatus) {
  return {
    broker: row.broker,
    status: row.status,
    lastSyncAt: row.lastSyncAt,
    lastErrorStep: row.lastErrorStep,
    tokenExpiresAt: row.tokenExpiresAt,
    credentialsSet: row.credentialsSet,
    credentialsUpdatedAt: row.credentialsUpdatedAt,
  };
}

export async function setKiteCredentials({ userId, password, totpSecret }: KiteCredentials) {
  await upsert("kite", {
    kiteUserIdEnc: encryptSecret(userId),
    kitePasswordEnc: encryptSecret(password),
    kiteTotpSecretEnc: encryptSecret(totpSecret),
    credentialsUpdatedAt: new Date(),
  });
}

async function kiteCredentialEnvelopes() {
  const c = brokerConnections;
  const [row] = await db
    .select({ u: c.kiteUserIdEnc, p: c.kitePasswordEnc, t: c.kiteTotpSecretEnc })
    .from(c)
    .where(eq(c.broker, "kite"));
  return row?.u && row.p && row.t ? { u: row.u, p: row.p, t: row.t } : null;
}

export async function loadKiteCredentials(): Promise<KiteCredentials | null> {
  const row = await kiteCredentialEnvelopes();
  if (!row) return null;
  return { userId: decryptSecret(row.u), password: decryptSecret(row.p), totpSecret: decryptSecret(row.t) };
}

/**
 * Whether all three stored Kite secrets decrypt under this env's keys (false when unset, or
 * saved under another ENCRYPTION_KEY). Decrypts and discards; never returns a value.
 */
export async function kiteCredentialsReadable(): Promise<boolean> {
  const row = await kiteCredentialEnvelopes();
  if (!row) return false;
  try {
    for (const env of [row.u, row.p, row.t]) decryptSecret(env);
    return true;
  } catch {
    return false; // wrong key / tampered: the owner re-enters them
  }
}

export async function saveMcpTokens(broker: Broker, tokens: unknown, expiresAt: Date | null = null) {
  await upsert(broker, { mcpTokensEnc: encryptSecret(JSON.stringify(tokens)), tokenExpiresAt: expiresAt });
}

export async function loadMcpTokens<T>(broker: Broker): Promise<T | null> {
  const [row] = await db
    .select({ enc: brokerConnections.mcpTokensEnc })
    .from(brokerConnections)
    .where(eq(brokerConnections.broker, broker));
  return row?.enc ? (JSON.parse(decryptSecret(row.enc)) as T) : null;
}

export async function saveMcpClientInfo(broker: Broker, info: unknown) {
  await upsert(broker, { mcpClientInfoEnc: encryptSecret(JSON.stringify(info)) });
}

export async function loadMcpClientInfo<T>(broker: Broker): Promise<T | null> {
  const [row] = await db
    .select({ enc: brokerConnections.mcpClientInfoEnc })
    .from(brokerConnections)
    .where(eq(brokerConnections.broker, broker));
  return row?.enc ? (JSON.parse(decryptSecret(row.enc)) as T) : null;
}

/** Pending OAuth connect: state hash + encrypted PKCE verifier + expiry. Replaces any earlier one. */
export async function saveOAuthState(broker: Broker, stateHash: string, verifier: string, expiresAt: Date) {
  await upsert(broker, {
    oauthStateHash: stateHash,
    oauthCodeVerifierEnc: encryptSecret(verifier),
    oauthStateExpiresAt: expiresAt,
  });
}

/**
 * Single-use: returns the PKCE verifier only if `stateHash` matches (constant-time) and has not
 * expired, clearing it atomically so a replay gets null. Mismatch, expiry and reuse all → null.
 */
export async function consumeOAuthState(broker: Broker, stateHash: string, now = new Date()) {
  const c = brokerConnections;
  const [row] = await db
    .select({ hash: c.oauthStateHash, enc: c.oauthCodeVerifierEnc, exp: c.oauthStateExpiresAt })
    .from(c)
    .where(eq(c.broker, broker));
  if (!row?.hash || !row.enc || !row.exp) return null;
  const a = Buffer.from(row.hash);
  const b = Buffer.from(stateHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const cleared = await db
    .update(c)
    .set({ oauthStateHash: null, oauthCodeVerifierEnc: null, oauthStateExpiresAt: null, updatedAt: now })
    .where(and(eq(c.broker, broker), eq(c.oauthStateHash, row.hash)))
    .returning({ id: c.id });
  // Expired states are cleared too (above), but never honoured.
  if (cleared.length === 0 || row.exp <= now) return null;
  return decryptSecret(row.enc);
}

/** Sets status; `error` is redacted before it is stored. Omitting it clears the last error. `syncedAt` sets last_sync_at. */
export async function setStatus(
  broker: Broker,
  status: BrokerStatus,
  { error, step, syncedAt }: { error?: string; step?: string; syncedAt?: Date } = {},
) {
  await upsert(broker, {
    status,
    lastError: error ? redact(error) : null,
    lastErrorStep: step ?? null,
    ...(syncedAt ? { lastSyncAt: syncedAt } : {}),
  });
}
