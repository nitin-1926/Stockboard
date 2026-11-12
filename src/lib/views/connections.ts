// Server-only: broker connection banners for the app shell. Owners get the failing step
// and a reconnect action; everyone else only learns how old the data is.
import { and, eq, max } from "drizzle-orm";
import { db } from "@/db";
import { syncRuns } from "@/db/schema";
import { type Actor, getActor } from "@/lib/auth/access";
import { type Broker, getConnection, publicConnectionView } from "@/lib/brokers/connections";
import { isStale } from "@/lib/jobs/schedule";

type PublicConnection = ReturnType<typeof publicConnectionView>;

export const BROKER_LABEL: Record<Broker, string> = { kite: "Kite", indmoney: "INDmoney" };
const SYNC_JOB = { kite: "kite-sync", indmoney: "indmoney-sync" } as const;

export type Banner =
  | { broker: Broker; label: string; asOf: string | null; problem: "stale" | "login_failed" | "needs_consent" | "sync_late" | "disconnected"; step: string | null; owner: true }
  | { broker: Broker; label: string; asOf: string | null; owner: false };

export interface ConnectionsView {
  banners: Banner[];
  /** At least one broker has been connected or has synced: decides the "no data yet" CTA. */
  anyConnected: boolean;
}

/** Pure. A broker that was never set up gets no banner (the empty state covers it). */
export function buildConnectionsView(
  conns: { view: PublicConnection; lastSuccessAt: Date | null }[],
  actor: Actor,
  now: Date,
): ConnectionsView {
  const banners: Banner[] = [];
  for (const { view, lastSuccessAt } of conns) {
    const s = view.status;
    const problem =
      s === "stale" || s === "login_failed" || s === "needs_consent"
        ? s
        : s === "connected" && isStale(SYNC_JOB[view.broker], lastSuccessAt, now)
          ? "sync_late"
          : s === "disconnected" && view.lastSyncAt
            ? "disconnected"
            : null;
    if (!problem) continue;
    const base = { broker: view.broker, label: BROKER_LABEL[view.broker], asOf: view.lastSyncAt?.toISOString() ?? null };
    banners.push(actor.kind === "owner" ? { ...base, problem, step: view.lastErrorStep, owner: true } : { ...base, owner: false });
  }
  return { banners, anyConnected: conns.some((c) => c.view.status !== "disconnected" || c.view.lastSyncAt) };
}

export async function getConnectionsView(): Promise<ConnectionsView | null> {
  const actor = await getActor();
  if ("denied" in actor) return null;
  const brokers: Broker[] = ["kite", "indmoney"];
  const conns = await Promise.all(
    brokers.map(async (b) => {
      const [[last], conn] = await Promise.all([
        db
          .select({ at: max(syncRuns.finishedAt) })
          .from(syncRuns)
          .where(and(eq(syncRuns.job, SYNC_JOB[b]), eq(syncRuns.status, "completed"))),
        getConnection(b),
      ]);
      return { view: publicConnectionView(conn), lastSuccessAt: last?.at ?? null };
    }),
  );
  return buildConnectionsView(conns, actor, new Date());
}
