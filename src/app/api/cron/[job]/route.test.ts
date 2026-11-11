import { randomUUID } from "node:crypto";
import { desc, eq, like, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, pool } from "@/db";
import { syncRuns } from "@/db/schema";
import { createCronHandler } from "@/lib/jobs/handler";
import type { JobFn } from "@/lib/jobs/registry";

// Integration test against the real Neon DB. Skips when DATABASE_URL is absent (CI).
describe.skipIf(!process.env.DATABASE_URL)("POST /api/cron/[job] (Neon)", () => {
  const prefix = `test-${randomUUID().slice(0, 8)}-`;
  const SECRET = "test-secret-0123456789abcdef";
  const FAKE_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
  const job = (name: string) => prefix + name;

  let release: () => void = () => {};
  const registry: Record<string, JobFn> = {
    [job("ok")]: async () => ({ counts: { rows: 3 } }),
    [job("holiday")]: async () => ({ counts: { bars: 0 }, status: "holiday" }),
    [job("chunk")]: async ({ cursor }) =>
      cursor === null ? { counts: { n: 1 }, done: false, cursor: { page: 2 } } : { counts: { n: 2 } },
    [job("boom")]: async () => {
      throw new Error(`kite said no: Bearer ${FAKE_JWT} request_token=abc123 ${FAKE_JWT}`);
    },
    [job("slow")]: () =>
      new Promise((resolve) => {
        release = () => resolve({ counts: {} });
      }),
  };
  const { POST, GET } = createCronHandler(registry);

  const call = (name: string, auth: string | null = `Bearer ${SECRET}`) =>
    POST(
      new Request(`http://x/api/cron/${name}`, {
        method: "POST",
        headers: auth ? { authorization: auth } : {},
      }),
      { params: Promise.resolve({ job: name }) },
    );
  const rows = (name: string) =>
    db.select().from(syncRuns).where(eq(syncRuns.job, name)).orderBy(desc(syncRuns.startedAt));

  const saved = process.env.CRON_SECRET;
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
  });
  afterEach(() => {
    process.env.CRON_SECRET = saved;
  });
  afterAll(async () => {
    await db.delete(syncRuns).where(like(syncRuns.job, `${prefix}%`));
    await pool.end();
  });

  it("401 on missing or wrong bearer, no row written", async () => {
    expect((await call(job("ok"), null)).status).toBe(401);
    expect((await call(job("ok"), "Bearer nope")).status).toBe(401);
    expect((await call(job("ok"), SECRET)).status).toBe(401); // no "Bearer " scheme
    expect(await rows(job("ok"))).toHaveLength(0);
  });

  it("500 misconfigured when CRON_SECRET is empty or short", async () => {
    process.env.CRON_SECRET = "";
    const res = await call(job("ok"), "Bearer ");
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "misconfigured" });
    process.env.CRON_SECRET = "short";
    expect((await call(job("ok"), "Bearer short")).status).toBe(500);
  });

  it("404 on unknown job (including prototype keys)", async () => {
    expect((await call(job("nope"))).status).toBe(404);
    expect((await call("constructor")).status).toBe(404);
  });

  it("405 on GET", () => {
    expect(GET().status).toBe(405);
  });

  it("completes with counts", async () => {
    const res = await call(job("ok"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: "completed", counts: { rows: 3 }, done: true });
    const [row] = await rows(job("ok"));
    expect(row).toMatchObject({ id: body.runId, status: "completed", counts: { rows: 3 } });
    expect(row.finishedAt).toBeInstanceOf(Date);
  });

  it("a job-reported holiday is stored as status holiday", async () => {
    const body = await (await call(job("holiday"))).json();
    expect(body).toMatchObject({ ok: true, status: "holiday" });
    const [row] = await rows(job("holiday"));
    expect(row.status).toBe("holiday");
  });

  it("persists the cursor between chunked runs", async () => {
    const first = await (await call(job("chunk"))).json();
    expect(first).toMatchObject({ done: false, cursor: { page: 2 } });
    const second = await (await call(job("chunk"))).json();
    expect(second).toMatchObject({ done: true, counts: { n: 2 }, cursor: null });
  });

  it("job throws → failed row, 500, credentials redacted", async () => {
    const res = await call(job("boom"));
    expect(res.status).toBe(500);
    const [row] = await rows(job("boom"));
    expect(row.status).toBe("failed");
    expect(row.error).toContain("kite said no");
    expect(row.error).not.toContain("eyJhbGci");
    expect(row.error).not.toContain("abc123");
    expect(JSON.stringify(await res.json())).not.toContain("eyJhbGci");
  });

  it("skips while a fresh run is in flight", async () => {
    const inflight = call(job("slow"));
    await expect
      .poll(async () => (await rows(job("slow")))[0]?.status, { timeout: 15_000 })
      .toBe("running");
    const res = await call(job("slow"));
    expect(await res.json()).toMatchObject({ ok: true, status: "skipped" });
    expect(res.status).toBe(200);
    release();
    expect((await inflight).status).toBe(200);
    const statuses = (await rows(job("slow"))).map((r) => r.status).sort();
    expect(statuses).toEqual(["completed", "skipped"]);
  });

  it("recovers a stuck running row older than 10 min, then runs", async () => {
    const [stuck] = await db
      .insert(syncRuns)
      .values({ job: job("ok"), startedAt: sql`now() - interval '11 minutes'` })
      .returning();
    const res = await call(job("ok"));
    expect(await res.json()).toMatchObject({ status: "completed" });
    const [old] = await db.select().from(syncRuns).where(eq(syncRuns.id, stuck.id));
    expect(old).toMatchObject({ status: "failed", error: "stale: exceeded runtime (killed)" });
  });
});
