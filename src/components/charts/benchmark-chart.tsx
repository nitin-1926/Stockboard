"use client";

import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { formatMoney } from "@/components/money";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";

export type BenchmarkPoint = { date: string; portfolio: number; benchmark: number | null };

/** "Aug 26" over long spans, "15 Aug" over short ones (else neighbouring ticks repeat). */
const tick = (iso: string, withYear: boolean) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", month: "short", ...(withYear ? { year: "2-digit" } : { day: "numeric" }) });
const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });

/**
 * Bucket value (brand line) vs the same cash flows in the index (neutral dashed line, so the two
 * differ by more than color). The caller renders the legend and a text summary; the chart itself
 * is hidden from screen readers.
 */
export function BenchmarkChart({ points, normalized, benchmarkLabel }: { points: BenchmarkPoint[]; normalized: boolean; benchmarkLabel: string }) {
  const config = {
    portfolio: { label: "This bucket", color: "var(--brand)" },
    benchmark: { label: benchmarkLabel, color: "var(--faint)" },
  } satisfies ChartConfig;
  const fmt = (v: number, compact = true) => (normalized ? v.toFixed(compact ? 0 : 1) : formatMoney(v, "INR", { compact }));
  const hasBenchmark = points.some((p) => p.benchmark != null);
  const withYear = points.length > 1 && Date.parse(points.at(-1)!.date) - Date.parse(points[0].date) > 200 * 86_400_000;

  return (
    <div aria-hidden>
      <ChartContainer config={config} className="aspect-auto h-56 w-full sm:h-72" initialDimension={{ width: 640, height: 288 }}>
        <LineChart data={points} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={48}
            tickFormatter={(d: string) => tick(d, withYear)}
            tick={{ fontSize: 11, fill: "var(--faint)" }}
          />
          <YAxis
            width={normalized ? 36 : 60}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => fmt(v)}
            tick={{ fontSize: 11, fill: "var(--faint)" }}
            domain={["auto", "auto"]}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(_, payload) => longDate(String(payload?.[0]?.payload?.date ?? ""))}
                formatter={(v, name) => (
                  <span className="flex w-full justify-between gap-4">
                    <span className="text-muted-foreground">{config[name as keyof typeof config]?.label}</span>
                    <span className="num">{fmt(Number(v), false)}</span>
                  </span>
                )}
              />
            }
          />
          {hasBenchmark && (
            <Line
              dataKey="benchmark"
              type="monotone"
              stroke="var(--color-benchmark)"
              strokeWidth={1.5}
              strokeDasharray="4 4"
              dot={false}
              isAnimationActive={false}
            />
          )}
          <Line dataKey="portfolio" type="monotone" stroke="var(--color-portfolio)" strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ChartContainer>
    </div>
  );
}
