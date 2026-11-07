import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GrantRow } from "./grants";
import { signShareCookie, verifyShareCookie } from "./share-link";

// Session path of requireActor is exercised with Next/Better Auth mocked; the pure
// resolvers below need none of it. DB-backed paths live in access.db.test.ts.
const mocks = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string } },
  grant: null as null | Partial<GrantRow>,
  setKiteCredentials: vi.fn(),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./config", () => ({ auth: { api: { getSession: async () => mocks.session } } }));
vi.mock("./grants", async (orig) => ({
  ...(await orig<typeof import("./grants")>()),
  findGrant: async () => mocks.grant,
}));
vi.mock("@/lib/brokers/connections", () => ({ setKiteCredentials: mocks.setKiteCredentials }));
vi.mock("@/db", () => ({ db: { delete: () => ({ where: async () => {} }) } }));

const { actorForEmail, actorForShareLink, can, requireActor } = await import("./access");
type Actor = import("./access").Actor;

const NOW = new Date("2026-11-11T12:00:00Z");
const YESTERDAY = new Date("2026-11-10T12:00:00Z");
const TOMORROW = new Date("2026-11-12T12:00:00Z");
const OWNER = "gupta7nitin@gmail.com";

const grant = (g: Partial<GrantRow> = {}) => ({
  role: "contributor" as const,
  hideAmounts: false,
  expiresAt: null,
  revokedAt: null,
  ...g,
});
const link = (l: object = {}) => ({ hideAmounts: false, expiresAt: null, revokedAt: null, ...l });
const actor = (r: ReturnType<typeof actorForEmail>): Actor => {
  if ("denied" in r) throw new Error(`expected an actor, got ${r.denied}`);
  return r;
};

beforeEach(() => {
  vi.stubEnv("OWNER_EMAIL", OWNER);
  vi.stubEnv("SHARE_LINK_SECRET", "s".repeat(44));
});
afterEach(() => vi.unstubAllEnvs());

describe("session resolution", () => {
  it("owner email resolves to owner with manage", () => {
    const a = actor(actorForEmail(OWNER, null, NOW));
    expect(a).toEqual({ kind: "owner", email: OWNER, hideAmounts: false, via: "session" });
    expect(can(a, "manage")).toBe(true);
  });

  it.each(["Gupta7Nitin@Gmail.com", "GUPTA7NITIN@GMAIL.COM", " gupta7nitin@gmail.com".trim()])(
    "owner email case variant %s still resolves to owner",
    (email) => expect(actor(actorForEmail(email, null, NOW)).kind).toBe("owner"),
  );

  it("owner wins even if a stale grant row exists for the owner email", () => {
    expect(actor(actorForEmail(OWNER, grant({ role: "viewer", revokedAt: YESTERDAY }), NOW)).kind).toBe("owner");
  });

  it("OWNER_EMAIL unset → nobody is owner", () => {
    vi.stubEnv("OWNER_EMAIL", "");
    expect(actorForEmail(OWNER, null, NOW)).toEqual({ denied: "NOT_INVITED" });
  });

  it("invited contributor resolves to contributor: suggest yes, manage no", () => {
    const a = actor(actorForEmail("C@Example.com", grant({ expiresAt: TOMORROW }), NOW));
    expect(a).toEqual({ kind: "contributor", email: "c@example.com", hideAmounts: false, via: "session" });
    expect(can(a, "suggest")).toBe(true);
    expect(can(a, "manage")).toBe(false);
  });

  it("invited viewer with hide-amounts carries the flag", () => {
    const a = actor(actorForEmail("v@example.com", grant({ role: "viewer", hideAmounts: true }), NOW));
    expect(a.kind).toBe("viewer");
    expect(a.hideAmounts).toBe(true);
  });

  it("grant expired yesterday → no access (ACCESS_EXPIRED)", () => {
    expect(actorForEmail("c@example.com", grant({ expiresAt: YESTERDAY }), NOW)).toEqual({ denied: "ACCESS_EXPIRED" });
  });

  it("revoked grant → no access (ACCESS_EXPIRED)", () => {
    expect(actorForEmail("c@example.com", grant({ revokedAt: YESTERDAY }), NOW)).toEqual({ denied: "ACCESS_EXPIRED" });
  });

  it("uninvited email → no access (NOT_INVITED)", () => {
    expect(actorForEmail("stranger@example.com", null, NOW)).toEqual({ denied: "NOT_INVITED" });
  });
});

describe("share-link resolution", () => {
  it("active link resolves to viewer, carrying hide-amounts", () => {
    expect(actorForShareLink(link({ hideAmounts: true, expiresAt: TOMORROW }), NOW)).toEqual({
      kind: "viewer",
      hideAmounts: true,
      via: "share-link",
    });
  });

  it("is always viewer even if the row were tampered to say contributor/owner", () => {
    for (const role of ["contributor", "owner"]) {
      const a = actorForShareLink(link({ role, kind: role }), NOW)!;
      expect(a.kind).toBe("viewer");
      expect(can(a, "suggest")).toBe(false);
      expect(can(a, "manage")).toBe(false);
    }
  });

  it("revoked or expired link → no access", () => {
    expect(actorForShareLink(link({ revokedAt: YESTERDAY }), NOW)).toBeNull();
    expect(actorForShareLink(link({ expiresAt: YESTERDAY }), NOW)).toBeNull();
    expect(actorForShareLink(null, NOW)).toBeNull();
  });

  it("cookie HMAC: round-trips; tampered, unsigned or wrong-secret cookies → null", () => {
    const id = "6f1c0b8e-3a5d-4e0f-9b1a-2c3d4e5f6a7b";
    const signed = signShareCookie(id);
    expect(verifyShareCookie(signed)).toBe(id);
    expect(verifyShareCookie(`00000000-0000-0000-0000-000000000000.${signed.split(".")[1]}`)).toBeNull();
    expect(verifyShareCookie(`${id}.AAAA`)).toBeNull();
    expect(verifyShareCookie(id)).toBeNull();
    expect(verifyShareCookie("")).toBeNull();
    expect(verifyShareCookie(undefined)).toBeNull();
    vi.stubEnv("SHARE_LINK_SECRET", "t".repeat(44));
    expect(verifyShareCookie(signed)).toBeNull();
  });
});

describe("can() matrix", () => {
  const owner: Actor = { kind: "owner", email: OWNER, hideAmounts: false, via: "session" };
  const contributor: Actor = { kind: "contributor", email: "c@example.com", hideAmounts: false, via: "session" };
  const viewer: Actor = { kind: "viewer", email: "v@example.com", hideAmounts: false, via: "session" };
  const linkViewer: Actor = { kind: "viewer", hideAmounts: false, via: "share-link" };

  // Without a resource; edit_own is covered separately.
  const matrix = {
    read: [true, true, true, true],
    suggest: [true, true, false, false],
    create_bucket: [true, true, false, false],
    delete_bucket: [true, false, false, false],
    manage: [true, false, false, false],
  } as const;
  for (const [action, expected] of Object.entries(matrix)) {
    it(`${action}: owner/contributor/viewer/link = ${expected.join("/")}`, () => {
      const got = [owner, contributor, viewer, linkViewer].map((a) => can(a, action as keyof typeof matrix));
      expect(got).toEqual([...expected]);
    });
  }

  it("edit_own: contributor only on own records (case-insensitive); owner on any; viewer never", () => {
    expect(can(contributor, "edit_own", { by: "C@Example.com" })).toBe(true);
    expect(can(contributor, "edit_own", { by: OWNER })).toBe(false);
    expect(can(contributor, "edit_own", { by: null })).toBe(false);
    expect(can(contributor, "edit_own")).toBe(false);
    expect(can(owner, "edit_own", { by: "c@example.com" })).toBe(true);
    expect(can(viewer, "edit_own", { by: "v@example.com" })).toBe(false);
    expect(can(linkViewer, "edit_own", { by: null })).toBe(false);
  });
});

describe("requireActor + server action guard (session path, mocked)", () => {
  beforeEach(() => {
    mocks.setKiteCredentials.mockReset();
    mocks.grant = null;
  });

  it("contributor calling the credential-save action directly is rejected on the server", async () => {
    mocks.session = { user: { id: "u1", email: "c@example.com" } };
    mocks.grant = grant();
    const { saveKiteCredentials } = await import("@/app/(app)/settings/brokers/actions");
    const fd = new FormData();
    fd.set("userId", "AB1234");
    fd.set("password", "pw");
    fd.set("totpSecret", "JBSWY3DPEHPK3PXP");
    await expect(saveKiteCredentials(null, fd)).rejects.toThrow(/forbidden/i);
    expect(mocks.setKiteCredentials).not.toHaveBeenCalled();
  });

  it("owner calling the same action stores credentials", async () => {
    mocks.session = { user: { id: "u0", email: OWNER } };
    const { saveKiteCredentials } = await import("@/app/(app)/settings/brokers/actions");
    const fd = new FormData();
    fd.set("userId", "AB1234");
    fd.set("password", "pw");
    fd.set("totpSecret", "JBSWY3DPEHPK3PXP");
    expect(await saveKiteCredentials(null, fd)).toEqual({ ok: true });
    expect(mocks.setKiteCredentials).toHaveBeenCalledWith({ userId: "AB1234", password: "pw", totpSecret: "JBSWY3DPEHPK3PXP" });
  });

  it("session whose grant expired → redirected to sign-in with ACCESS_EXPIRED", async () => {
    mocks.session = { user: { id: "u2", email: "c@example.com" } };
    mocks.grant = grant({ expiresAt: new Date(Date.now() - 86_400_000) });
    await expect(requireActor()).rejects.toMatchObject({ digest: expect.stringContaining("/sign-in?error=ACCESS_EXPIRED") });
  });

  it("no session and no share cookie → redirected to /sign-in", async () => {
    mocks.session = null;
    await expect(requireActor()).rejects.toMatchObject({ digest: expect.stringContaining(";/sign-in;") });
  });
});
