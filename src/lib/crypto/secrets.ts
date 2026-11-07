import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM envelopes: `v1:<iv>:<tag>:<ciphertext>`, each part base64url.
// Decrypt never falls back: tamper, wrong key or unknown version all throw.
// Rotation: move the old key to ENCRYPTION_KEY_PREVIOUS (decrypt-only), set a
// new ENCRYPTION_KEY, re-save every secret, then drop the previous key. See docs/adr/0009.

const VERSION = "v1";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
// base64 of exactly 32 bytes is 43 chars plus one `=` pad.
const KEY_FORMAT = /^[A-Za-z0-9+/]{43}=$/;

type KeyVar = "ENCRYPTION_KEY" | "ENCRYPTION_KEY_PREVIOUS";

// Read on every call (cheap) so a missing/bad key fails at first use, naming the variable.
function readKey(name: KeyVar): Buffer | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  if (!KEY_FORMAT.test(raw)) throw new Error(`${name} must be base64 of exactly 32 bytes`);
  return Buffer.from(raw, "base64");
}

function currentKey(): Buffer {
  const key = readKey("ENCRYPTION_KEY");
  if (!key) throw new Error("ENCRYPTION_KEY is not set");
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, currentKey(), iv, { authTagLength: TAG_BYTES });
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const parts = [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64url"));
  return [VERSION, ...parts].join(":");
}

function open(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer): string {
  const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function decryptSecret(envelope: string): string {
  const parts = envelope.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("decryptSecret: unsupported envelope");
  const [iv, tag, ct] = parts.slice(1).map((p) => Buffer.from(p, "base64url"));
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("decryptSecret: malformed envelope");

  const keys = [currentKey(), readKey("ENCRYPTION_KEY_PREVIOUS")].filter((k): k is Buffer => !!k);
  for (const key of keys) {
    try {
      return open(key, iv, tag, ct);
    } catch {
      // Auth failure under this key; try the next. All failing throws below.
    }
  }
  throw new Error("decryptSecret: authentication failed (tampered data or wrong key)");
}
