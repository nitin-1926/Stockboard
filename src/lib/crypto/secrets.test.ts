import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret } from "./secrets";

const newKey = () => randomBytes(32).toString("base64");

// Flip one bit in the decoded bytes of envelope part `i` (1 = iv, 2 = tag, 3 = ct).
function flip(envelope: string, i: number): string {
  const parts = envelope.split(":");
  const buf = Buffer.from(parts[i], "base64url");
  buf[0] ^= 0x01;
  parts[i] = buf.toString("base64url");
  return parts.join(":");
}

describe("secrets", () => {
  beforeEach(() => {
    vi.stubEnv("ENCRYPTION_KEY", newKey());
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("round-trips ASCII and unicode", () => {
    for (const s of ["hunter2", "", "पासवर्ड ✓ 🔑 naïve"]) {
      const env = encryptSecret(s);
      expect(env).toMatch(/^v1:[\w-]+:[\w-]+:[\w-]*$/);
      expect(decryptSecret(env)).toBe(s);
    }
  });

  it("produces a different envelope each time", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it.each([
    ["iv", 1],
    ["tag", 2],
    ["ciphertext", 3],
  ])("throws on a flipped byte in the %s", (_, i) => {
    const env = encryptSecret("secret-value");
    expect(() => decryptSecret(flip(env, i))).toThrow();
  });

  it("throws on a truncated tag", () => {
    const [v, iv, tag, ct] = encryptSecret("x").split(":");
    const short = Buffer.from(tag, "base64url").subarray(0, 8).toString("base64url");
    expect(() => decryptSecret([v, iv, short, ct].join(":"))).toThrow();
  });

  it("throws under the wrong key", () => {
    const env = encryptSecret("secret-value");
    vi.stubEnv("ENCRYPTION_KEY", newKey());
    expect(() => decryptSecret(env)).toThrow(/authentication failed/);
  });

  it("decrypts an old envelope via ENCRYPTION_KEY_PREVIOUS, and encrypts with the new key", () => {
    const oldKey = process.env.ENCRYPTION_KEY!;
    const env = encryptSecret("rotated");
    vi.stubEnv("ENCRYPTION_KEY", newKey());
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", oldKey);
    expect(decryptSecret(env)).toBe("rotated");
    const fresh = encryptSecret("fresh");
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", "");
    expect(decryptSecret(fresh)).toBe("fresh");
  });

  it("names ENCRYPTION_KEY when it is missing or the wrong length", () => {
    const env = encryptSecret("x");
    vi.stubEnv("ENCRYPTION_KEY", "");
    expect(() => encryptSecret("x")).toThrow(/ENCRYPTION_KEY is not set/);
    vi.stubEnv("ENCRYPTION_KEY", randomBytes(16).toString("base64"));
    expect(() => encryptSecret("x")).toThrow(/ENCRYPTION_KEY must be base64 of exactly 32 bytes/);
    expect(() => decryptSecret(env)).toThrow(/ENCRYPTION_KEY must be/);
  });

  it("names ENCRYPTION_KEY_PREVIOUS when it is malformed", () => {
    const env = encryptSecret("x");
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", "short");
    expect(() => decryptSecret(env)).toThrow(/ENCRYPTION_KEY_PREVIOUS/);
  });

  it("rejects unknown versions and malformed envelopes", () => {
    const env = encryptSecret("x");
    expect(() => decryptSecret(env.replace(/^v1:/, "v2:"))).toThrow(/unsupported envelope/);
    expect(() => decryptSecret("plaintext-password")).toThrow(/unsupported envelope/);
    expect(() => decryptSecret(`${env}:extra`)).toThrow(/unsupported envelope/);
  });
});
