import { createHash, timingSafeEqual } from "node:crypto";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { syncRuns } from "@/db/schema";
import type { JobFn, JobResult } from "./registry";

const STALE_ERROR = "stale: exceeded runtime (killed)";
const MIN_SECRET_LENGTH = 16;

const json = (body: unknown, status = 200) => Response.json(body, { status });

// Digest both sides so the buffers are equal length and the secret's length doesn't leak.
function bearerMatches(header: string | null, secret: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(header.slice(7)), digest(secret));
}

/** Strips credential-looking values before an error message is persisted. */
export function redact(message: string): string {
  return message
    .replace(/eyJ[\w-]*(\.[\w-]*){0,2}/g, "[redacted-jwt]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\b((?:access_|refresh_|request_|id_|enc)?token|cookie|set-cookie|authorization|password|secret|api_?key|totp)\b(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      "$1$2[redacted]",
    )
    .slice(0, 2000);
}

// Runs older than this are presumed killed by Vercel (300 s) and recovered as failed.
const STALE_AFTER = sql`interval '10 minutes'`;

export type RunOutcome =
  | { runId: string; status: "skipped" }
  | { runId: string; status: "completed" | "holiday"; counts: JobResult["counts"]; done: boolean; cursor: unknown }
  | { runId: string; status: "failed"; error: string };

/**
 * Runs `fn` as `job` under a sync_runs row: overlap guard, stuck-run recovery, cursor hand-off,
 * redacted error. Shared by the cron route and owner-triggered runs. No auth here; callers check.
 */
export async function runJob(job: string, fn: JobFn): Promise<RunOutcome> {
  // Advisory lock serializes check-then-insert, so two concurrent calls can't both start.
  const start = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cron:${job}`}))`);
    // A Vercel kill (300 s) never reaches the finally below; recover those rows here.
    await tx
      .update(syncRuns)
      .set({ status: "failed", error: STALE_ERROR, finishedAt: sql`now()` })
      .where(
        and(eq(syncRuns.job, job), eq(syncRuns.status, "running"), sql`${syncRuns.startedAt} < now() - ${STALE_AFTER}`),
      );
    const [busy] = await tx
      .select({ id: syncRuns.id })
      .from(syncRuns)
      .where(and(eq(syncRuns.job, job), eq(syncRuns.status, "running")))
      .limit(1);
    if (busy) {
      const [row] = await tx
        .insert(syncRuns)
        .values({ job, status: "skipped", finishedAt: sql`now()`, error: `overlaps run ${busy.id}` })
        .returning({ id: syncRuns.id });
      return { runId: row.id, skipped: true as const };
    }
    const [prev] = await tx
      .select({ cursor: syncRuns.cursor })
      .from(syncRuns)
      .where(and(eq(syncRuns.job, job), eq(syncRuns.status, "completed")))
      .orderBy(desc(syncRuns.startedAt))
      .limit(1);
    const [row] = await tx.insert(syncRuns).values({ job }).returning({ id: syncRuns.id });
    return { runId: row.id, skipped: false as const, cursor: prev?.cursor ?? null };
  });

  const { runId } = start;
  if (start.skipped) return { runId, status: "skipped" };

  try {
    const result = await fn({ runId, cursor: start.cursor });
    const status = result.status ?? "completed";
    const cursor = result.done === false ? (result.cursor ?? null) : null;
    await db
      .update(syncRuns)
      .set({ status, finishedAt: sql`now()`, counts: result.counts, cursor })
      .where(eq(syncRuns.id, runId));
    return { runId, status, counts: result.counts, done: result.done ?? true, cursor };
  } catch (e) {
    const error = redact(e instanceof Error ? e.message : String(e));
    await db.update(syncRuns).set({ status: "failed", finishedAt: sql`now()`, error }).where(eq(syncRuns.id, runId));
    return { runId, status: "failed", error };
  }
}

/** True while a non-stale run of `job` is in flight (what runJob would skip on). */
export async function isRunning(job: string): Promise<boolean> {
  const [row] = await db
    .select({ id: syncRuns.id })
    .from(syncRuns)
    .where(
      and(eq(syncRuns.job, job), eq(syncRuns.status, "running"), sql`${syncRuns.startedAt} >= now() - ${STALE_AFTER}`),
    )
    .limit(1);
  return !!row;
}

/** Newest non-skipped run of `job` (status, times, counts; the error stays server-side). */
export async function lastRun(job: string) {
  const [row] = await db
    .select({ status: syncRuns.status, startedAt: syncRuns.startedAt, finishedAt: syncRuns.finishedAt, counts: syncRuns.counts })
    .from(syncRuns)
    .where(and(eq(syncRuns.job, job), ne(syncRuns.status, "skipped")))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);
  return row ?? null;
}

export function createCronHandler(registry: Record<string, JobFn>) {
  async function POST(req: Request, ctx: { params: Promise<{ job: string }> }) {
    const secret = process.env.CRON_SECRET ?? "";
    if (secret.length < MIN_SECRET_LENGTH) return json({ ok: false, error: "misconfigured" }, 500);
    if (!bearerMatches(req.headers.get("authorization"), secret)) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    const { job } = await ctx.params;
    const run = Object.hasOwn(registry, job) ? registry[job] : undefined;
    if (!run) return json({ ok: false, error: "unknown job" }, 404);

    const r = await runJob(job, run);
    if (r.status === "skipped") return json({ ok: true, runId: r.runId, status: "skipped", counts: {} });
    if (r.status === "failed") {
      return json({ ok: false, runId: r.runId, status: "failed", counts: {}, error: r.error }, 500);
    }
    return json({ ok: true, ...r });
  }

  // Explicit so the 405 is testable; other methods get Next's built-in 405.
  function GET() {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }

  return { POST, GET };
}
