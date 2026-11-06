# 0009. Broker secrets: AES-256-GCM envelopes, no plaintext fallback

- Status: Accepted
- Date: 2026-11-11

## Context

`broker_connections` holds Zerodha login secrets (user id, password, TOTP seed), MCP client registrations, access/refresh tokens and OAuth code verifiers. A DB dump or leaked backup must not expose them, and a bad key or corrupted row must never surface as a usable "secret". Zero-cost constraint: no KMS, no new dependency.

## Options considered

1. Postgres `pgcrypto`: the key travels in every SQL statement and can end up in query logs.
2. A crypto library (e.g. libsodium): a new dependency for what `node:crypto` already does.
3. App-side AES-256-GCM via `node:crypto`, with the key in an env var: authenticated encryption, no dependency, the key never reaches the DB.

## Decision

Option 3, in `src/lib/crypto/secrets.ts`.

- Envelope `v1:<iv>:<tag>:<ciphertext>`, each base64url, random 12-byte IV per encryption, 16-byte tag. The version prefix lets a future scheme coexist with old rows.
- `decryptSecret` throws on an unknown version, a malformed envelope, or an auth-tag failure (tamper or wrong key). There is no "not an envelope, so treat it as plaintext" path: that pattern silently turns a key mistake or a plaintext row into a working credential.
- `ENCRYPTION_KEY` is base64 of exactly 32 bytes, checked on first use with an error naming the variable.
- A DB `CHECK` on `broker_connections` rejects any non-null secret column that does not start with `v<n>:`.
- Separate keys per environment: production, preview and local dev each have their own random key, so a preview or dev leak cannot decrypt production rows.
- Rotation: move the current key to `ENCRYPTION_KEY_PREVIOUS` (decrypt-only fallback), set a new `ENCRYPTION_KEY`, re-save every secret (re-enter Kite credentials, refresh tokens), then remove the previous key.

## Consequences

- Losing `ENCRYPTION_KEY` means re-entering credentials and re-consenting INDmoney; nothing else is encrypted.
- No re-encryption job exists; rotation relies on secrets being rewritten naturally (tokens rotate daily). Add one if rotation becomes routine.
- Decryption happens only in server job/MCP paths (`src/lib/brokers/connections.ts`); the UI only ever receives `publicConnectionView`.
