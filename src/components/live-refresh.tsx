"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Headless: re-renders the server tree every intervalMs while the tab is visible (and once on return). */
export function LiveRefresh({ intervalMs = 30_000, enabled }: { intervalMs?: number; enabled: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const id = setInterval(refresh, intervalMs);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [enabled, intervalMs, router]);
  return null;
}
