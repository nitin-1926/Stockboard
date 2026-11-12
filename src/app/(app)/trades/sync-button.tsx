"use client";

import { RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { runKiteSyncNow } from "@/app/(app)/settings/brokers/actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Owner only (the action re-checks). Pulls today's Kite fills now instead of waiting for the evening sync. */
export function SyncNowButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await runKiteSyncNow();
          if (r.status === "completed") toast.success("Kite synced");
          else if (r.status === "skipped") toast("A sync is already running");
          else toast.error(r.step ? `Sync failed at ${r.step}` : "Sync failed");
          router.refresh();
        })
      }
    >
      <RefreshCwIcon className={cn(pending && "animate-spin")} strokeWidth={1.75} aria-hidden />
      {pending ? "Syncing" : "Sync now"}
    </Button>
  );
}
