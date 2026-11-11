import { withKite } from "@/lib/mcp/kite/auth";
import { kiteHeadlessLogin } from "@/lib/mcp/kite/headless-login";
import { getProfile } from "@/lib/mcp/kite/tools";
import { type BackfillCursor, runBackfill } from "./backfill";
import { runEod } from "./eod";
import { runJob } from "./handler";
import { syncKite } from "./kite-sync";
import { pricesIntraday } from "./prices-intraday";

export const JOB_NAMES = [
  "kite-login",
  "kite-sync",
  "indmoney-sync",
  "prices-intraday",
  "eod-in",
  "eod-us",
  "backfill",
] as const;

export type JobName = (typeof JOB_NAMES)[number];

/** `cursor` is the cursor the previous completed run of this job left (null when it finished). */
export type JobContext = { runId: string; cursor: unknown };

/**
 * Return `done: false` plus a `cursor` to be called again (chunked work under the 300 s limit).
 * `status: "holiday"` marks a run that found no new bar for its market (sync_runs keeps it).
 */
export type JobResult = {
  counts: Record<string, number | string>;
  done?: boolean;
  cursor?: unknown;
  status?: "holiday";
};

export type JobFn = (ctx: JobContext) => Promise<JobResult>;

const kiteSync: JobFn = ({ runId }) => syncKite(runId);

// One headless login (no retry), one read to prove the new token works, then a sync on the fresh
// session under its own sync_runs row. A failed sync doesn't fail the login; its row says why.
async function kiteLogin(): Promise<JobResult> {
  await kiteHeadlessLogin();
  await withKite(getProfile);
  const sync = await runJob("kite-sync", kiteSync);
  return { counts: { connected: 1, sync: sync.status } };
}

// INDmoney waits on its U1/U6 part.
const blocked: JobFn = async () => ({ counts: { blocked: "awaiting broker integration" } });

export const registry: Record<JobName, JobFn> = {
  "kite-login": kiteLogin,
  "kite-sync": kiteSync,
  "indmoney-sync": blocked,
  "prices-intraday": () => pricesIntraday(),
  "eod-in": () => runEod("IN"),
  "eod-us": () => runEod("US"),
  backfill: ({ cursor }) => runBackfill(cursor as BackfillCursor | null),
};
