import { EyeIcon, Settings2Icon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { Can } from "@/components/can";
import { LiveRefresh } from "@/components/live-refresh";
import { formatAsOf } from "@/components/money";
import { MobileNav, TopNav } from "@/components/shell/nav";
import { SignOutButton } from "@/components/shell/sign-out-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { getActor } from "@/lib/auth/access";
import { isMarketOpen } from "@/lib/jobs/schedule";
import { cn } from "@/lib/utils";
import { type Banner, getConnectionsView } from "@/lib/views/connections";

// The shell makes NO access decisions: every page calls requireActor() through its view
// module, inside its own <Suspense> (so client navigations stay instant). Actor-dependent
// shell parts (settings group, sign-out, banners) only hide or show UI.
export default function AppLayout({ children }: LayoutProps<"/">) {
  const owner = (node: React.ReactNode) => (
    <Suspense fallback={null}>
      <Can action="manage">{node}</Can>
    </Suspense>
  );
  const signOut = (
    <Suspense fallback={null}>
      <SessionOnly>
        <SignOutButton />
      </SessionOnly>
    </Suspense>
  );

  return (
    <div className="flex min-h-dvh flex-1 flex-col">
      <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <div className="mx-auto flex h-14 w-full max-w-[1280px] items-center gap-6 px-4 sm:px-6 lg:px-8">
          <Brand />
          <Suspense fallback={<div className="hidden flex-1 lg:block" />}>
            <TopNav />
          </Suspense>
          <div className="ml-auto flex items-center gap-1">
            <Suspense fallback={null}>
              <MarketStatus />
            </Suspense>
            <ThemeToggle />
            {owner(
              <Button
                asChild
                variant="ghost"
                size="icon"
                aria-label="Settings"
                className="hidden lg:inline-flex"
              >
                <Link href="/settings/brokers">
                  <Settings2Icon strokeWidth={1.75} />
                </Link>
              </Button>,
            )}
            <span className="hidden lg:contents">{signOut}</span>
          </div>
        </div>
      </header>
      <Suspense fallback={null}>
        <ReadOnlyBanner />
      </Suspense>
      <Suspense fallback={null}>
        <ConnectionBanners />
      </Suspense>
      <main className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col px-4 pt-6 pb-28 sm:px-6 lg:px-8 lg:pt-8 lg:pb-16">
        {children}
      </main>

      <Suspense fallback={null}>
        <MobileNav
          moreSlot={
            <div className="flex flex-col">
              {owner(
                <Link
                  href="/settings/brokers"
                  className="flex min-h-12 items-center gap-3 rounded-md px-3 text-sm font-medium text-muted-foreground"
                >
                  <Settings2Icon
                    className="size-4.5"
                    strokeWidth={1.75}
                    aria-hidden
                  />
                  Settings
                </Link>,
              )}
              {signOut}
            </div>
          }
        />
      </Suspense>
    </div>
  );
}

function Brand() {
  return (
    <Link
      href="/"
      className="flex items-center gap-2 rounded-md text-[15px] font-semibold tracking-[-0.02em]"
    >
      <span
        aria-hidden
        className="grid size-5 place-items-center rounded-[5px] bg-foreground"
      >
        <span className="size-2 rounded-[2px] bg-brand" />
      </span>
      Stockboard
    </Link>
  );
}

/** Real state only: NSE / NYSE open or closed, from the exchange calendars in jobs/schedule. */
async function MarketStatus() {
  await connection();
  const now = new Date();
  const markets = [
    { key: "IN", label: "NSE", open: isMarketOpen("IN", now) },
    { key: "US", label: "NYSE", open: isMarketOpen("US", now) },
  ] as const;
  return (
    <div className="mr-2 flex items-center gap-3 text-xs text-muted-foreground max-sm:[&>span]:hidden">
      {/* Live prices: re-render every 30s while any market is open (views refresh stale quotes on read). */}
      <LiveRefresh enabled={markets.some((m) => m.open)} intervalMs={30_000} />
      {markets.map((m) => (
        <span
          key={m.key}
          className="flex items-center gap-1.5"
          title={`${m.label} ${m.open ? "open" : "closed"}`}
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-full",
              m.open ? "animate-live bg-gain" : "bg-faint",
            )}
          />
          {m.label}
          <span className="sr-only">{m.open ? " open" : " closed"}</span>
        </span>
      ))}
    </div>
  );
}

async function SessionOnly({ children }: { children: React.ReactNode }) {
  const actor = await getActor();
  return "denied" in actor || actor.via !== "session" ? null : children;
}

async function ReadOnlyBanner() {
  const actor = await getActor();
  if ("denied" in actor || actor.via !== "share-link") return null;
  return (
    <div
      role="status"
      className="border-b bg-muted px-4 py-2 text-center text-[13px] text-muted-foreground"
    >
      <EyeIcon className="mr-1.5 inline size-4 align-[-3px]" aria-hidden />
      Read-only shared view{actor.hideAmounts ? ". Amounts are hidden." : "."}
    </div>
  );
}

const PROBLEM: Record<Extract<Banner, { owner: true }>["problem"], string> = {
  stale: "session expired",
  login_failed: "login failed",
  needs_consent: "needs consent",
  sync_late: "sync is late",
  disconnected: "is disconnected",
};

async function ConnectionBanners() {
  const view = await getConnectionsView();
  if (!view?.banners.length) return null;
  return (
    <div className="flex flex-col divide-y border-b bg-brand/8">
      {view.banners.map((b) => {
        const asOf = b.asOf
          ? `data as of ${formatAsOf(b.asOf)}`
          : "no data synced yet";
        return (
          <div
            key={b.broker}
            role="status"
            className="mx-auto flex w-full max-w-[1280px] flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 text-[13px] sm:px-6 lg:px-8"
          >
            <TriangleAlertIcon
              className="size-4 shrink-0 text-brand"
              aria-hidden
            />
            {b.owner ? (
              <>
                <p className="min-w-0 flex-1">
                  <span className="font-medium">
                    {b.label} {PROBLEM[b.problem]}
                  </span>
                  {b.step && (
                    <span className="text-muted-foreground">
                      {" "}
                      at step {b.step}
                    </span>
                  )}
                  <span className="text-muted-foreground">
                    . {asOf[0].toUpperCase() + asOf.slice(1)}.
                  </span>
                </p>
                <Button asChild size="sm" variant="outline">
                  <Link href="/settings/brokers">Reconnect</Link>
                </Button>
              </>
            ) : (
              <p className="min-w-0 flex-1 text-muted-foreground">
                {b.label} {asOf}.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
