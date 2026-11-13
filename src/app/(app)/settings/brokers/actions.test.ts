import { and, eq, gte } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Access, the job function and the connection read are mocked; sync_runs is the real Neon
// table, so the shared runJob bookkeeping is what's under test. Rows are deleted by run id.
const mem = vi.hoisted(() => ({ owner: true, step: null as string | null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/access", () => ({
  authorize: vi.fn(async () => {
    if (!mem.owner) throw new Error("Forbidden");
    return { kind: "owner" };
  }),
}));
vi.mock("@/lib/jobs/registry", () => ({ registry: { "kite-login": vi.fn(), "kite-sync": vi.fn() } }));
vi.mock("@/lib/brokers/connections", () => ({
  setKiteCredentials: vi.fn(),
  getConnection: vi.fn(async () => ({ lastErrorStep: mem.step })),
}));

const { db, pool } = await import("@/db");
const { syncRuns } = await import("@/db/schema");
const { registry } = await import("@/lib/jobs/registry");
const { runKiteLoginNow, runKiteSyncNow } = await import("./actions");

describe.skipIf(!process.env.DATABASE_URL)("runKiteLoginNow (Neon sync_runs)", () => {
  const job = vi.mocked(registry["kite-login"]);
  const runIds: string[] = [];
  const row = async (id: string) => (await db.select().from(syncRuns).where(eq(syncRuns.id, id)))[0];

  beforeEach(() => {
    vi.clearAllMocks();
    mem.owner = true;
    mem.step = null;
    job.mockImplementation(async ({ runId }) => {
      runIds.push(runId);
      return { counts: { connected: 1 } };
    });
  });
  afterAll(async () => {
    for (const id of runIds) await db.delete(syncRuns).where(eq(syncRuns.id, id));
    await pool.end();
  });

  it("rejects a non-owner before any run row is written", async () => {
    const since = new Date();
    mem.owner = false;
    await expect(runKiteLoginNow()).rejects.toThrow("Forbidden");
    expect(job).not.toHaveBeenCalled();
    const rows = await db
      .select()
      .from(syncRuns)
      .where(and(eq(syncRuns.job, "kite-login"), gte(syncRuns.startedAt, since)));
    expect(rows).toHaveLength(0);
  });

  it("success → completed kite-login row with the job's counts", async () => {
    expect(await runKiteLoginNow()).toEqual({ status: "completed" });
    expect(job).toHaveBeenCalledOnce();
    const r = await row(runIds.at(-1)!);
    expect(r).toMatchObject({ job: "kite-login", status: "completed", counts: { connected: 1 } });
    expect(r.finishedAt).toBeInstanceOf(Date);
  });

  it("Sync Kite now → a completed kite-sync row from the sync job; non-owner refused", async () => {
    const sync = vi.mocked(registry["kite-sync"]);
    sync.mockImplementation(async ({ runId }) => {
      runIds.push(runId);
      return { counts: { snapshots: 3 } };
    });
    expect(await runKiteSyncNow()).toEqual({ status: "completed" });
    expect(job).not.toHaveBeenCalled();
    expect(await row(runIds.at(-1)!)).toMatchObject({ job: "kite-sync", status: "completed", counts: { snapshots: 3 } });
    mem.owner = false;
    await expect(runKiteSyncNow()).rejects.toThrow("Forbidden");
    expect(sync).toHaveBeenCalledOnce();
  });

  it("failure → only status + stored step returned; error redacted in sync_runs", async () => {
    mem.step = "twofa";
    job.mockImplementation(async ({ runId }) => {
      runIds.push(runId);
      throw new Error("kite login failed at twofa: password=hunter2 Bearer eyJabc.def.ghi");
    });
    const res = await runKiteLoginNow();
    expect(res).toEqual({ status: "failed", step: "twofa" });
    const r = await row(runIds.at(-1)!);
    expect(r.status).toBe("failed");
    expect(r.error).not.toContain("hunter2");
    expect(r.error).not.toContain("eyJabc");
  });
});
