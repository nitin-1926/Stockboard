import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth/access";

const getActor = vi.fn();
vi.mock("@/lib/auth/access", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/access")>()), getActor }));
const exportSheets = vi.fn();
vi.mock("@/lib/export/sheets", async (orig) => ({ ...(await orig<typeof import("@/lib/export/sheets")>()), exportSheets }));

const { GET } = await import("./route");

const owner: Actor = { kind: "owner", email: "o@example.com", hideAmounts: false, via: "session" };
const viewer: Actor = { kind: "viewer", hideAmounts: true, via: "share-link" };
const call = (kind: string, format = "csv") =>
  GET(new Request(`http://x/api/export/${kind}?format=${format}`), { params: Promise.resolve({ kind }) });

beforeEach(() => {
  getActor.mockReset();
  exportSheets.mockReset().mockResolvedValue([{ name: "T", columns: [{ header: "Symbol", kind: "text" }], rows: [["=1+1"]] }]);
});

describe("GET /api/export/[kind]", () => {
  it("unauthenticated (or a dead share link) → 401 JSON, not a redirect, nothing loaded", async () => {
    for (const denied of ["SIGNED_OUT", "LINK_INVALID", "ACCESS_EXPIRED"]) {
      getActor.mockResolvedValue({ denied });
      const res = await call("holdings");
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: denied });
    }
    expect(exportSheets).not.toHaveBeenCalled();
  });

  it("a viewer or contributor requesting the ledger → 403", async () => {
    for (const a of [viewer, { ...owner, kind: "contributor" as const, email: "c@example.com" }]) {
      getActor.mockResolvedValue(a);
      expect((await call("ledger", "xlsx")).status).toBe(403);
    }
    expect(exportSheets).not.toHaveBeenCalled();
  });

  it("owner ledger CSV: attachment with the dated filename, no-store, inert cells", async () => {
    getActor.mockResolvedValue(owner);
    const res = await call("ledger");
    expect(res.status).toBe(200);
    expect(exportSheets).toHaveBeenCalledWith("ledger", owner, expect.any(Date));
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="stockboard-ledger-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.text()).toBe("Symbol\r\n'=1+1\r\n");
  });

  it("viewer holdings XLSX is allowed; unknown kind 404, bad format 400", async () => {
    getActor.mockResolvedValue(viewer);
    const res = await call("holdings", "xlsx");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
    expect(exportSheets).toHaveBeenCalledWith("holdings", viewer, expect.any(Date));
    expect((await call("secrets")).status).toBe(404);
    expect((await call("holdings", "pdf")).status).toBe(400);
  });
});
