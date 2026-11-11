import type { JobName } from "./registry";

type Schedule = { slots: string[]; graceMin: number }; // slots: "HH:MM" UTC, Mon–Fri

const every15 = (fromHour: number, toHour: number) =>
  Array.from({ length: (toHour - fromHour + 1) * 4 }, (_, i) => {
    const h = fromHour + Math.floor(i / 4);
    return `${String(h).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`;
  });

/** Mirrors .github/workflows/cron-*.yml. Keep the two in sync. */
export const SCHEDULES: Record<JobName, Schedule | null> = {
  "kite-login": { slots: ["02:30"], graceMin: 90 },
  // 11:30 is a self-heal retry, so it is covered by the grace rather than being its own slot.
  "kite-sync": { slots: ["10:15"], graceMin: 150 },
  "indmoney-sync": { slots: ["21:15"], graceMin: 90 },
  "prices-intraday": { slots: [...every15(3, 10), ...every15(13, 21)], graceMin: 60 },
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
