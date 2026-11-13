import type { ReactNode } from "react";

/** Centered minimal card for pages outside the app shell (sign-in, dead share links). */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-1 items-center justify-center bg-background px-4 py-12">
      <div className="flex w-full max-w-[360px] flex-col gap-6 rounded-lg border bg-card p-6 sm:p-8">
        {/* Same wordmark as the shell's Brand. */}
        <div className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.02em]">
          <span aria-hidden className="grid size-5 place-items-center rounded-[5px] bg-foreground">
            <span className="size-2 rounded-[2px] bg-brand" />
          </span>
          Stockboard
        </div>
        <div className="flex flex-col gap-4">
          <h1 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h1>
          {children}
        </div>
      </div>
    </main>
  );
}
