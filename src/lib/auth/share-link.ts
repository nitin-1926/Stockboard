// Share-link token + cookie primitives. Pure (node:crypto only), so the proxy and
// tests can import it without pulling in the DB.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SHARE_COOKIE = "sb_share";
/** Cookie lifetime cap; the link row is still re-validated on every request. */
export const SHARE_COOKIE_MAX_AGE_S = 7 * 24 * 60 * 60;

/** 32 random bytes, base64url (43 chars). Shown once; only its hash is stored. */
export const mintToken = () => randomBytes(32).toString("base64url");
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const isWellFormedToken = (token: string) => /^[A-Za-z0-9_-]{43}$/.test(token);

function secret(): string {
  const s = process.env.SHARE_LINK_SECRET ?? "";
  if (s.length < 32) throw new Error("SHARE_LINK_SECRET is missing or shorter than 32 chars");
  return s;
}

const mac = (id: string) => createHmac("sha256", secret()).update(id).digest("base64url");

/** Cookie value `<linkId>.<hmac>`; the HMAC stops a client from naming another link id. */
export const signShareCookie = (linkId: string) => `${linkId}.${mac(linkId)}`;

/** Returns the link id, or null for anything unsigned, malformed or tampered with. */
export function verifyShareCookie(value: string | undefined | null): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(mac(id));
  return given.length === expected.length && timingSafeEqual(given, expected) ? id : null;
}
