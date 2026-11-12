import { Skeleton } from "@/components/ui/skeleton";

/** Fallback for a page's request-time (actor-dependent) content. */
export function PageSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-32 w-full max-w-md" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}
