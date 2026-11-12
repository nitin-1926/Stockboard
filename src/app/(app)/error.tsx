"use client";

import { TriangleAlertIcon } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
      <p className="flex items-center gap-2 text-[13px]">
        <TriangleAlertIcon className="size-4 shrink-0 text-loss" aria-hidden />
        This page could not load.
      </p>
      <Button variant="outline" onClick={() => retry()}>
        Try again
      </Button>
    </div>
  );
}
