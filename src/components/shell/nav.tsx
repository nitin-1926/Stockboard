"use client";

import {
  ArrowLeftRightIcon,
  BriefcaseBusinessIcon,
  EllipsisIcon,
  EyeIcon,
  LayersIcon,
  LayoutGridIcon,
  type LucideIcon,
  TargetIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";

type Item = { href: string; label: string; icon: LucideIcon };

export const PRIMARY: Item[] = [
  { href: "/", label: "Overview", icon: LayoutGridIcon },
  { href: "/holdings", label: "Holdings", icon: BriefcaseBusinessIcon },
  { href: "/trades", label: "Trades", icon: ArrowLeftRightIcon },
  { href: "/watchlist", label: "Watchlist", icon: EyeIcon },
  { href: "/buckets", label: "Buckets", icon: LayersIcon },
  { href: "/targets", label: "Targets", icon: TargetIcon },
];
const BOTTOM = PRIMARY.slice(0, 4);

const isActive = (path: string | null, href: string) =>
  !!path && (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));

/** Desktop primary nav: text tabs with a brand underline on the active one. */
export function TopNav() {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="hidden h-full items-stretch gap-1 lg:flex">
      {PRIMARY.map((item) => {
        const active = isActive(path, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex items-center px-3 text-[13px] font-medium transition-colors",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
            <span
              aria-hidden
              className={cn(
                "absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-brand transition-opacity",
                active ? "opacity-100" : "opacity-0",
              )}
            />
          </Link>
        );
      })}
    </nav>
  );
}

/** Phone/tablet: fixed bottom tab bar; "More" opens a sheet with the rest + owner settings. */
export function MobileNav({ moreSlot }: { moreSlot?: ReactNode }) {
  const path = usePathname();
  // Open state is tied to the path it was opened on, so navigating closes it without an effect.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn !== null && openOn === path;
  const setOpen = (next: boolean | ((o: boolean) => boolean)) =>
    setOpenOn((typeof next === "function" ? next(open) : next) ? path : null);
  const inMore = !!path && !BOTTOM.some((i) => isActive(path, i.href));

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="More">
          <button aria-label="Close" className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="absolute inset-x-0 bottom-0 rounded-t-xl border-t bg-popover px-3 pt-3 pb-[calc(5rem+env(safe-area-inset-bottom))]">
            <ul className="flex flex-col">
              {PRIMARY.slice(4).map((item) => (
                <li key={item.href}>
                  <SheetLink item={item} active={isActive(path, item.href)} />
                </li>
              ))}
            </ul>
            {moreSlot && <div className="mt-2 border-t pt-2">{moreSlot}</div>}
          </div>
        </div>
      )}
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-50 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        <ul className="grid grid-cols-5">
          {BOTTOM.map((item) => {
            const active = isActive(path, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-14 flex-col items-center justify-center gap-1 text-[11px] font-medium",
                    active ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  <item.icon className={cn("size-5", active && "text-brand")} strokeWidth={1.75} aria-hidden />
                  {item.label}
                </Link>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className={cn(
                "flex min-h-14 w-full flex-col items-center justify-center gap-1 text-[11px] font-medium",
                inMore || open ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <EllipsisIcon className={cn("size-5", inMore && "text-brand")} strokeWidth={1.75} aria-hidden />
              More
            </button>
          </li>
        </ul>
      </nav>
    </>
  );
}

function SheetLink({ item, active }: { item: Item; active: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-12 items-center gap-3 rounded-md px-3 text-sm font-medium",
        active ? "bg-muted text-foreground" : "text-muted-foreground",
      )}
    >
      <item.icon className="size-4.5" strokeWidth={1.75} aria-hidden />
      {item.label}
    </Link>
  );
}

/** Settings sub-navigation (owner only). Underlined tabs, horizontally scrollable on phones. */
export const SETTINGS: { href: string; label: string }[] = [
  { href: "/settings/brokers", label: "Brokers" },
  { href: "/settings/sharing", label: "Sharing" },
  { href: "/settings/import", label: "Import" },
  { href: "/settings/ledger", label: "Ledger" },
  { href: "/settings/preferences", label: "Preferences" },
];

export function SettingsTabs() {
  const path = usePathname();
  return (
    <nav aria-label="Settings" className="-mx-4 overflow-x-auto border-b px-4 sm:mx-0 sm:px-0">
      <ul className="flex gap-1">
        {SETTINGS.map((s) => {
          const active = isActive(path, s.href);
          return (
            <li key={s.href}>
              <Link
                href={s.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex h-10 items-center px-3 text-[13px] font-medium whitespace-nowrap transition-colors",
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {s.label}
                {active && <span aria-hidden className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-brand" />}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
