import type { JobName } from "./registry";

type Schedule = { slots: string[]; graceMin: number }; // slots: "HH:MM" UTC, Mon–Fri

/** "HH:MM" UTC slots every `step` minutes from `from` to `to` inclusive (both "HH:MM"). */
const every = (step: number, from: string, to: string) => {
  const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const out: string[] = [];
  for (let m = mins(from); m <= mins(to); m += step)
    out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  return out;
};

/** Mirrors .github/workflows/cron-*.yml. Keep the two in sync. */
export const SCHEDULES: Record<JobName, Schedule | null> = {
  "kite-login": { slots: ["02:30"], graceMin: 90 },
  // Hourly 09:30-15:30 IST, then 15:45 IST after close. 11:30 is a self-heal retry, covered by grace.
  "kite-sync": { slots: [...every(60, "04:00", "10:00"), "10:15"], graceMin: 90 },
  "indmoney-sync": { slots: ["21:15"], graceMin: 90 },
  // NSE every 5 min 09:15-15:30 IST; NYSE every 15 min across both DST offsets.
  "prices-intraday": { slots: [...every(5, "03:45", "10:00"), ...every(15, "13:00", "21:45")], graceMin: 60 },
  "eod-in": { slots: ["11:00"], graceMin: 90 },
  "eod-us": { slots: ["21:30"], graceMin: 90 },
  backfill: null, // manual only
};

const DAY_MS = 86_400_000;

/**
 * Stale when the newest scheduled slot whose grace has fully elapsed has no success at or
 * after it. Weekend slots don't exist, so a Friday success stays fresh until Monday's slot
 * plus grace. Market holidays are not modelled.
 */
export function isStale(job: JobName, lastSuccessAt: Date | null, now: Date): boolean {
  const schedule = SCHEDULES[job];
  if (!schedule) return false;
  const deadline = now.getTime() - schedule.graceMin * 60_000;
  const slotsDesc = [...schedule.slots].sort().reverse();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let d = 0; d <= 7; d++) {
    const day = today - d * DAY_MS;
    const dow = new Date(day).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    for (const slot of slotsDesc) {
      const [h, m] = slot.split(":").map(Number);
      const expected = day + (h * 60 + m) * 60_000;
      if (expected <= deadline) return !lastSuccessAt || lastSuccessAt.getTime() < expected;
    }
  }
  return false;
}

const MARKETS = {
  IN: { tz: "Asia/Kolkata", open: 9 * 60 + 15, close: 15 * 60 + 30 },
  US: { tz: "America/New_York", open: 9 * 60 + 30, close: 16 * 60 },
} as const;

/** Regular session in the exchange's local time (DST via Intl), weekdays; holidays ignored. */
export function isMarketOpen(market: keyof typeof MARKETS, now: Date): boolean {
  const { tz, open, close } = MARKETS[market];
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= open && minutes <= close;
}
