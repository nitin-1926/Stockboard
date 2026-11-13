"use server";

import { revalidatePath } from "next/cache";
import { authorize } from "@/lib/auth/access";
import { getConnection, setKiteCredentials } from "@/lib/brokers/connections";
import { runJob } from "@/lib/jobs/handler";
import { registry } from "@/lib/jobs/registry";

export type FormResult = { ok: true } | { error: string } | null;

/** Write-only: values are encrypted and never sent back to the client. */
export async function saveKiteCredentials(_prev: FormResult, fd: FormData): Promise<FormResult> {
  await authorize("manage");
  const userId = String(fd.get("userId") ?? "").trim();
  const password = String(fd.get("password") ?? "");
  const totpSecret = String(fd.get("totpSecret") ?? "").replace(/\s+/g, "");
  if (!userId || !password || !totpSecret) return { error: "All three fields are required." };
  await setKiteCredentials({ userId, password, totpSecret });
  revalidatePath("/settings/brokers");
  return { ok: true };
}

export type LoginRunResult = { status: "completed" | "failed" | "skipped"; step?: string };

/**
 * Owner-triggered Kite job: the cron job's function under the same sync_runs bookkeeping, so it
 * can be run from Vercel without the CRON_SECRET. Returns status and the failed step (as stored
 * on the connection) only; the redacted error stays in sync_runs.
 */
async function runKiteJobNow(job: "kite-login" | "kite-sync"): Promise<LoginRunResult> {
  await authorize("manage");
  const r = await runJob(job, registry[job]);
  revalidatePath("/settings/brokers");
  if (r.status === "skipped") return { status: "skipped" };
  if (r.status !== "failed") return { status: "completed" };
  const { lastErrorStep } = await getConnection("kite");
  return lastErrorStep ? { status: "failed", step: lastErrorStep } : { status: "failed" };
}

/** `kite-login`: headless login, then (inside the job) a chained `kite-sync`. */
export async function runKiteLoginNow(): Promise<LoginRunResult> {
  return runKiteJobNow("kite-login");
}

/** `kite-sync` with the stored session (one re-login if it has expired). */
export async function runKiteSyncNow(): Promise<LoginRunResult> {
  return runKiteJobNow("kite-sync");
}
