"use client";

import { useSyncExternalStore } from "react";
import { Area, AreaChart, CartesianGrid, Tooltip, type TooltipContentProps, XAxis, YAxis } from "recharts";
import { Delta, formatMoney } from "@/components/money";
import { ChartContainer } from "@/components/ui/chart";

export type ValuePoint = { date: string; value?: number; index: number; dayPnlPct: number | null };

const REDUCED = "(prefers-reduced-motion: reduce)";
function useReducedMotion() {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(REDUCED);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(REDUCED).matches,
    () => true,
  );
}

const longSpan = (points: ValuePoint[]) =>
  points.length > 1 && Date.parse(points[points.length - 1].date) - Date.parse(points[0].date) > 200 * 86_400_000;
const tick = (iso: string, withYear: boolean) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", {
    timeZone: "UTC",
    month: "short",
    ...(withYear ? { year: "2-digit" } : { day: "numeric" }),
  });
const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" });

const AXIS = { fontSize: 11, fill: "var(--faint)" };
const format = (v: number, hidden: boolean, compact: boolean) => (hidden ? v.toFixed(compact ? 0 : 1) : formatMoney(v, "INR", { compact }));

/** ~4 evenly spaced round gridlines around [lo, hi] (1, 2, 2.5 or 5 times a power of ten). */
function niceTicks(lo: number, hi: number) {
  const raw = (hi - lo || Math.abs(hi) * 0.1 || 1) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw)!;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v < hi + step; v += step) out.push(v);
  if (out.length < 2) out.push(out[0] + step);
  return out;
}

function TooltipBody({ active, payload, hidden }: TooltipContentProps & { hidden: boolean }) {
  const p = active ? (payload?.[0]?.payload as ValuePoint | undefined) : undefined;
  if (!p) return null;
  return (
    <div className="flex flex-col gap-1 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg">
      <span className="text-muted-foreground">{longDate(p.date)}</span>
      <span className="flex items-baseline gap-3">
        <span className="num font-semibold">{format(hidden ? p.index : (p.value ?? 0), hidden, false)}</span>
        {p.dayPnlPct != null && <Delta value={p.dayPnlPct} />}
      </span>
    </div>
  );
}

/**
 * Portfolio value at each close as one brand line with a soft area. With amounts hidden it
 * draws the time-weighted index (100 at the range start) instead. `label` is the text
 * summary screen readers get in place of the drawing.
 */
export function ValueArea({ points, hidden, label }: { points: ValuePoint[]; hidden: boolean; label: string }) {
  const reduced = useReducedMotion();
  const key = hidden ? "index" : "value";
  const fmt = (v: number) => format(v, hidden, true);
  const withYear = longSpan(points);
  const values = points.map((p) => (hidden ? p.index : (p.value ?? 0)));
  const ticks = niceTicks(Math.min(...values), Math.max(...values));

  return (
    <div role="img" aria-label={label}>
      <ChartContainer
        config={{ [key]: { label: hidden ? "Index" : "Value", color: "var(--brand)" } }}
        className="aspect-auto h-56 w-full sm:h-72"
        initialDimension={{ width: 1200, height: 288 }}
      >
        <AreaChart data={points} margin={{ left: 0, right: 0, top: 8, bottom: 0 }} accessibilityLayer={false}>
          <defs>
            <linearGradient id="value-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--brand)" stopOpacity={0.18} />
              <stop offset="100%" stopColor="var(--brand)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tickMargin={10}
            minTickGap={56}
            tick={AXIS}
            tickFormatter={(d: string) => tick(d, withYear)}
          />
          <YAxis
            orientation="right"
            width={hidden ? 36 : 60}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            tick={AXIS}
            domain={[ticks[0], ticks.at(-1)!]}
            ticks={ticks}
            interval={0}
            tickFormatter={(v: number) => fmt(v)}
          />
          <Tooltip content={(props) => <TooltipBody {...props} hidden={hidden} />} cursor={{ stroke: "var(--border)" }} isAnimationActive={false} />
          <Area
            dataKey={key}
            type="monotone"
            stroke="var(--brand)"
            strokeWidth={1.75}
            fill="url(#value-fill)"
            dot={false}
            activeDot={{ r: 3.5, strokeWidth: 2, stroke: "var(--card)", fill: "var(--brand)" }}
            isAnimationActive={!reduced}
            animationDuration={400}
          />
        </AreaChart>
      </ChartContainer>
    </div>
  );
}
