"use client";

import { Loader2Icon } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { type LoginRunResult, runKiteLoginNow, runKiteSyncNow } from "./actions";

const JOBS = {
  login: {
    action: runKiteLoginNow,
    label: "Run automatic login now",
    runningLabel: "Login already running",
    ok: "Automatic login worked.",
    skipped: "A Kite login is already running.",
    failed: "Automatic login failed",
    error: "Could not run the automatic login.",
  },
  sync: {
    action: runKiteSyncNow,
    label: "Sync Kite now",
    runningLabel: "Sync already running",
    ok: "Kite synced.",
    skipped: "A Kite sync is already running.",
    failed: "Kite sync failed",
    error: "Could not run the Kite sync.",
  },
} satisfies Record<string, { action: () => Promise<LoginRunResult> } & Record<string, unknown>>;

// The actions revalidate /settings/brokers, so the status card refreshes with the result.
function KiteJobButton({ job, running, canRun, primary }: { job: keyof typeof JOBS; running: boolean; canRun: boolean; primary?: boolean }) {
  const j = JOBS[job];
  const [pending, start] = useTransition();
  const run = () =>
    start(async () => {
      try {
        const r = await j.action();
        if (r.status === "completed") toast.success(j.ok);
        else if (r.status === "skipped") toast.info(j.skipped);
        else toast.error(r.step ? `${j.failed} at step: ${r.step}.` : `${j.failed}.`);
      } catch {
        toast.error(j.error);
      }
    });
  return (
    <Button type="button" variant={primary ? "default" : "outline"} onClick={run} disabled={pending || running || !canRun}>
      {pending && <Loader2Icon className="animate-spin motion-reduce:animate-none" aria-hidden />}
      {running && !pending ? j.runningLabel : j.label}
    </Button>
  );
}

export const KiteLoginButton = (p: { running: boolean; canRun: boolean }) => <KiteJobButton job="login" {...p} />;
export const KiteSyncButton = (p: { running: boolean; canRun: boolean }) => <KiteJobButton job="sync" primary {...p} />;
