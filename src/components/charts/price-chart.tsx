"use client";

import { Area, AreaChart, CartesianGrid, ReferenceDot, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { type Ccy, formatMoney, formatQty } from "@/components/money";
import { ChartContainer } from "@/components/ui/chart";

export type PricePoint = { t: number; date: string; close: number };
export type PriceMarker = { kind: "buy" | "sell" | "watch"; date: string; t: number; price: number; qty?: number | null; approximate: boolean; label: string };
export type PriceLevel = { kind: "target" | "stop"; price: number };

const fmtDate = (t: number, opts: Intl.DateTimeFormatOptions) => new Date(t).toLocaleDateString("en-IN", { timeZone: "UTC", ...opts });
const AXIS = { fontSize: 11, fill: "var(--faint)" };

// Marker shapes differ by more than color: buy = filled ▲, sell = hollow ▼, watch = hollow ○.
// Each carries a <title>, so hovering a marker names it; the page lists them all in text too.
function Glyph({ kind, cx, cy, title }: { kind: PriceMarker["kind"]; cx?: number; cy?: number; title: string }) {
  if (cx == null || cy == null) return null;
  const ring = { stroke: "var(--card)", strokeWidth: 2, paintOrder: "stroke" } as const;
  return (
    <g style={{ cursor: "default" }}>
      <title>{title}</title>
      {kind === "buy" && <path d={`M${cx},${cy - 5} L${cx + 5},${cy + 4} L${cx - 5},${cy + 4} Z`} fill="var(--foreground)" {...ring} />}
      {kind === "sell" && (
        <path d={`M${cx - 5},${cy - 4} L${cx + 5},${cy - 4} L${cx},${cy + 5} Z`} fill="var(--card)" stroke="var(--foreground)" strokeWidth={1.5} />
      )}
      {kind === "watch" && <circle cx={cx} cy={cy} r={4} fill="var(--card)" stroke="var(--muted-foreground)" strokeWidth={1.5} />}
      {/* Hit area bigger than the mark. */}
      <circle cx={cx} cy={cy} r={11} fill="transparent" />
    </g>
  );
}

/**
 * Close price on today's share basis with trade, watch and target overlays. Decorative for
 * screen readers (aria-hidden): the page prints a table of every marker.
 */
export function PriceChart({ points, markers, levels, currency }: { points: PricePoint[]; markers: PriceMarker[]; levels: PriceLevel[]; currency: Ccy }) {
  const money = (v: number, compact = false) => formatMoney(v, currency, { decimals: 2, compact });
  const spanDays = points.length > 1 ? (points.at(-1)!.t - points[0].t) / 86_400_000 : 0;
  const tick = (t: number) => fmtDate(t, spanDays > 400 ? { month: "short", year: "2-digit" } : { day: "numeric", month: "short" });

  const TooltipBody = ({ active, payload }: { active?: boolean; payload?: readonly { payload?: unknown }[] }) => {
    const p = active ? (payload?.[0]?.payload as PricePoint | undefined) : undefined;
    if (!p) return null;
    return (
      <div className="flex flex-col gap-1 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg">
        <span className="text-muted-foreground">{fmtDate(p.t, { day: "numeric", month: "short", year: "numeric" })}</span>
        <span className="num font-semibold">{money(p.close)}</span>
      </div>
    );
  };

  return (
    <div aria-hidden className="flex flex-col gap-3">
      <ChartContainer config={{ close: { label: "Close", color: "var(--brand)" } }} className="aspect-auto h-64 w-full sm:h-80" initialDimension={{ width: 1200, height: 320 }}>
        <AreaChart data={points} margin={{ left: 0, right: 0, top: 12, bottom: 0 }} accessibilityLayer={false}>
          <defs>
            <linearGradient id="price-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--brand)" stopOpacity={0.14} />
              <stop offset="100%" stopColor="var(--brand)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            tickLine={false}
            axisLine={false}
            tickMargin={10}
            minTickGap={56}
            tick={AXIS}
            tickFormatter={tick}
          />
          <YAxis
            orientation="right"
            width={64}
            domain={["auto", "auto"]}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            tick={AXIS}
            tickCount={5}
            tickFormatter={(v: number) => money(v, true)}
          />
          <Tooltip content={TooltipBody} cursor={{ stroke: "var(--border)" }} isAnimationActive={false} />
          {levels.map((l) => (
            <ReferenceLine
              key={l.kind}
              y={l.price}
              ifOverflow="extendDomain"
              stroke="var(--muted-foreground)"
              strokeOpacity={0.6}
              strokeDasharray={l.kind === "target" ? "6 4" : "2 3"}
              label={{ value: `${l.kind === "target" ? "Target" : "Stop"} ${money(l.price)}`, position: "insideTopLeft", fill: "var(--muted-foreground)", fontSize: 11 }}
            />
          ))}
          <Area
            dataKey="close"
            type="linear"
            stroke="var(--brand)"
            strokeWidth={1.75}
            fill="url(#price-fill)"
            dot={false}
            activeDot={{ r: 3.5, strokeWidth: 2, stroke: "var(--card)", fill: "var(--brand)" }}
            isAnimationActive={false}
          />
          {markers.map((m, i) => (
            <ReferenceDot
              key={`${m.kind}-${m.t}-${i}`}
              x={m.t}
              y={m.price}
              ifOverflow="extendDomain"
              shape={(p: { cx?: number; cy?: number }) => (
                <Glyph
                  kind={m.kind}
                  cx={p.cx}
                  cy={p.cy}
                  title={`${m.label}${m.qty != null ? ` ${formatQty(m.qty)}` : ""} at ${money(m.price)}, ${fmtDate(m.t, { day: "numeric", month: "short", year: "numeric" })}${m.approximate ? " (approximate)" : ""}`}
                />
              )}
            />
          ))}
        </AreaChart>
      </ChartContainer>
      <Legend markers={markers} levels={levels} />
    </div>
  );
}

/** Only the overlays present; a lone price line needs no legend. */
function Legend({ markers, levels }: { markers: PriceMarker[]; levels: PriceLevel[] }) {
  const has = (k: PriceMarker["kind"]) => markers.some((m) => m.kind === k);
  const lvl = (k: PriceLevel["kind"]) => levels.some((l) => l.kind === k);
  const items = [
    { show: has("buy"), key: "buy", glyph: <svg viewBox="0 0 12 12" className="size-2.5"><path d="M6,1 L11,10 L1,10 Z" fill="var(--foreground)" /></svg>, label: "Buy" },
    { show: has("sell"), key: "sell", glyph: <svg viewBox="0 0 12 12" className="size-2.5"><path d="M1,2 L11,2 L6,11 Z" fill="none" stroke="var(--foreground)" strokeWidth="1.5" /></svg>, label: "Sell" },
    { show: has("watch"), key: "watch", glyph: <svg viewBox="0 0 12 12" className="size-2.5"><circle cx="6" cy="6" r="4" fill="none" stroke="var(--muted-foreground)" strokeWidth="1.5" /></svg>, label: "Watchlist add" },
    { show: lvl("target"), key: "target", glyph: <span className="w-4 border-t border-dashed border-muted-foreground" />, label: "Target" },
    { show: lvl("stop"), key: "stop", glyph: <span className="w-4 border-t border-dotted border-muted-foreground" />, label: "Stop" },
  ].filter((i) => i.show);
  if (!items.length) return null;
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-faint">
      {items.map((i) => (
        <li key={i.key} className="inline-flex items-center gap-1.5">
          {i.glyph}
          {i.label}
        </li>
      ))}
    </ul>
  );
}
