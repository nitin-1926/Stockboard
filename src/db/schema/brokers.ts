import { sql } from "drizzle-orm";
import { check, numeric, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const brokerEnum = pgEnum("broker", ["kite", "indmoney"]);
export const brokerStatusEnum = pgEnum("broker_status", [
  "disconnected",
  "connected",
  "stale",
  "login_failed",
  "needs_consent",
]);

// One row per broker. Every `*_enc` column holds a `v1:` envelope from
// src/lib/crypto/secrets.ts; the CHECK keeps plaintext out at the DB level.
export const brokerConnections = pgTable(
  "broker_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    broker: brokerEnum("broker").notNull().unique(),
    status: brokerStatusEnum("status").notNull().default("disconnected"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastError: text("last_error"), // redacted before write
    lastErrorStep: text("last_error_step"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    kiteUserIdEnc: text("kite_user_id_enc"),
    kitePasswordEnc: text("kite_password_enc"),
    kiteTotpSecretEnc: text("kite_totp_secret_enc"),
    mcpClientInfoEnc: text("mcp_client_info_enc"), // DCR registration JSON
    mcpTokensEnc: text("mcp_tokens_enc"), // access/refresh JSON (Kite: the stored JWT)
    // OAuth connect state: hash only, single-use, expiring (cleared on callback).
    oauthStateHash: text("oauth_state_hash"),
    oauthCodeVerifierEnc: text("oauth_code_verifier_enc"),
    oauthStateExpiresAt: timestamp("oauth_state_expires_at", { withTimezone: true }),
    credentialsUpdatedAt: timestamp("credentials_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // NULL columns make their term NULL, which a CHECK accepts; any non-envelope value is false.
    check(
      "broker_connections_enc_envelope",
      sql`${t.kiteUserIdEnc} ~ '^v[0-9]+:' AND ${t.kitePasswordEnc} ~ '^v[0-9]+:'
        AND ${t.kiteTotpSecretEnc} ~ '^v[0-9]+:' AND ${t.mcpClientInfoEnc} ~ '^v[0-9]+:'
        AND ${t.mcpTokensEnc} ~ '^v[0-9]+:' AND ${t.oauthCodeVerifierEnc} ~ '^v[0-9]+:'`,
    ),
  ],
);

/**
 * Latest equity-segment margins per broker (U10), overwritten by each sync. All three are
 * amounts: hide-amounts viewers never receive them (MARGINS_POLICY in src/lib/views/margins.ts).
 */
export const marginsLatest = pgTable("margins_latest", {
  broker: brokerEnum("broker").primaryKey(),
  /** Kite `available.cash`. */
  cash: numeric("cash", { mode: "string" }).notNull(),
  /** Kite `utilised.debits` (margin in use). */
  used: numeric("used", { mode: "string" }).notNull(),
  /** Kite `net`: what is available to trade. */
  net: numeric("net", { mode: "string" }).notNull(),
  asOf: timestamp("as_of", { withTimezone: true }).notNull(),
});
