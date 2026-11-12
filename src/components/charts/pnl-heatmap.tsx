"use client";

import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Delta, formatMoney, formatPercent } from "@/components/money";

export type HeatDay = { date: string; pct: number | null; pnl?: number };

const DAY = 86_400_000;
/** |day return| thresholds for intensity levels 1..4 (fixed, so the legend can name them). */
const LEVELS = [0.005, 0.01, 0.02];
const MIX = [22, 42, 64, 88];
const FLAT = 0.0005;
const CELL = 13;
const GAP = 3;

const t = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
/** Monday of the week containing `ms` (UTC). */
const monday = (ms: number) => ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY;
const fullDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" });
const month = (ms: number) => new Date(ms).toLocaleDateString("en-IN", { timeZone: "UTC", month: "short" });

const level = (pct: number) => LEVELS.filter((x) => Math.abs(pct) >= x).length;
const dir = (pct: number | null) => (pct == null || Math.abs(pct) < FLAT ? 0 : pct > 0 ? 1 : -1);

function cellStyle(pct: number | null) {
  const d = dir(pct);
  if (!d) return { background: "var(--muted)" };
  const l = level(pct!);
  const tone = d > 0 ? "var(--gain)" : "var(--loss)";
  return { background: `color-mix(in oklch, ${tone} ${MIX[l]}%, var(--card))` };
}

function describe(d: HeatDay) {
  const s = dir(d.pct);
  const pct = d.pct == null ? "no change measured" : `${s > 0 ? "up" : s < 0 ? "down" : "flat"} ${formatPercent(Math.abs(d.pct))}`;
  const amt = d.pnl == null ? "" : `, ${d.pnl < 0 ? "−" : ""}${formatMoney(Math.abs(d.pnl), "INR")}`;
  return `${fullDate(d.date)}: ${pct}${amt}`;
}

interface Block {
  label: string | null;
  start: number;
  weeks: number;
  /** Index into `days` for each placed cell. */
  cells: { i: number; col: number; row: number }[];
  months: { col: number; label: string }[];
}

/** One grid for a year or less; one per calendar year beyond that, so ALL never scrolls for metres. */
function blocks(days: HeatDay[]): Block[] {
  if (!days.length) return [];
  const span = t(days[days.length - 1].date) - t(days[0].date);
  const groups: [string | null, number[]][] = [];
  if (span <= 371 * DAY) groups.push([null, days.map((_, i) => i)]);
  else
    for (const [i, d] of days.entries()) {
      const y = d.date.slice(0, 4);
      const g = groups.at(-1);
      if (g && g[0] === y) g[1].push(i);
      else groups.push([y, [i]]);
    }
  return groups.map(([label, idx]) => {
    const first = t(days[idx[0]].date);
    const last = t(days[idx[idx.length - 1]].date);
    const start = monday(first);
    const pos = (ms: number) => ({ col: Math.floor((ms - start) / (7 * DAY)), row: (new Date(ms).getUTCDay() + 6) % 7 });
    const months: Block["months"] = [];
    for (let c = 0, ms = start; ms <= last; c++, ms += 7 * DAY) {
      const lbl = month(Math.max(ms, first));
      if (months.at(-1)?.label !== lbl && (c === 0 || new Date(ms).getUTCDate() <= 7)) months.push({ col: c, label: lbl });
    }
    return {
      label,
      start,
      weeks: pos(last).col + 1,
      cells: idx.map((i) => ({ i, ...pos(t(days[i].date)) })),
      months,
    };
  });
}

/**
 * Calendar heatmap of day P&L in the active gain/loss palette. Every trading day is a
 * button (one tab stop, arrow keys move: up/down one trading day, left/right one week)
 * with a full text label; focus or hover shows a tooltip. Market holidays stay blank.
 */
export function PnlHeatmap({ days, caption }: { days: HeatDay[]; caption: string }) {
  const [focusIdx, setFocusIdx] = useState(days.length - 1);
  const [tip, setTip] = useState<{ i: number; x: number; y: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const cells = useRef(new Map<number, HTMLButtonElement>());
  const grid = blocks(days);

  // Most recent days are on the right: start scrolled there on narrow screens.
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
  }, [days.length]);
  useEffect(() => {
    const el = scroller.current;
    const hide = () => setTip(null);
    el?.addEventListener("scroll", hide, { passive: true });
    return () => el?.removeEventListener("scroll", hide);
  }, []);

  const show = (i: number) => {
    const el = cells.current.get(i);
    const box = wrap.current?.getBoundingClientRect();
    if (!el || !box) return;
    const r = el.getBoundingClientRect();
    // Keep the tooltip inside the card at the edges.
    const x = Math.max(90, Math.min(r.left - box.left + r.width / 2, box.width - 90));
    setTip({ i, x, y: r.top - box.top });
  };
  const move = (i: number) => {
    const n = Math.max(0, Math.min(days.length - 1, i));
    setFocusIdx(n);
    cells.current.get(n)?.focus();
  };
  /** Nearest trading day a week away (at or before going back, at or after going forward). */
  const weekAway = (i: number, sign: 1 | -1) => {
    const target = t(days[i].date) + sign * 7 * DAY;
    let j = i;
    while (j + sign >= 0 && j + sign < days.length && (sign > 0 ? t(days[j].date) < target : t(days[j + sign].date) >= target)) j += sign;
    return sign < 0 && j > 0 && t(days[j].date) > target ? j - 1 : j;
  };
  const onKey = (e: KeyboardEvent, i: number) => {
    const next = { ArrowUp: i - 1, ArrowDown: i + 1, ArrowLeft: weekAway(i, -1), ArrowRight: weekAway(i, 1), Home: 0, End: days.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    move(next);
  };

  const tipDay = tip ? days[tip.i] : null;

  return (
    <div ref={wrap} className="relative flex flex-col gap-3">
      <div ref={scroller} className="relative overflow-x-auto pb-1">
        <div role="group" aria-label={caption} className="flex w-max flex-col gap-4">
          {grid.map((b) => (
            <div key={b.label ?? "range"} className="flex flex-col gap-1">
              {b.label && <p className="text-xs font-medium text-muted-foreground">{b.label}</p>}
              <div className="flex">
                <div aria-hidden className="sticky left-0 z-[1] grid bg-card pt-5 pr-2 text-[11px] leading-none text-faint" style={{ gridTemplateRows: `repeat(5, ${CELL}px)`, rowGap: GAP }}>
                  <span className="self-center">Mon</span>
                  <span />
                  <span className="self-center">Wed</span>
                  <span />
                  <span className="self-center">Fri</span>
                </div>
                <div className="flex flex-col gap-1">
                  <div aria-hidden className="relative h-4 text-[11px] leading-4 text-faint" style={{ width: b.weeks * (CELL + GAP) }}>
                    {b.months.map((m) => (
                      <span key={`${m.col}-${m.label}`} className="absolute" style={{ left: m.col * (CELL + GAP) }}>
                        {m.label}
                      </span>
                    ))}
                  </div>
                  <div
                    className="grid"
                    style={{ gridTemplateRows: `repeat(5, ${CELL}px)`, gridAutoColumns: `${CELL}px`, gap: GAP, gridAutoFlow: "column" }}
                  >
                    {b.cells.map(({ i, col, row }) => {
                      const d = days[i];
                      return (
                        <button
                          key={d.date}
                          ref={(el) => {
                            if (el) cells.current.set(i, el);
                            else cells.current.delete(i);
                          }}
                          type="button"
                          tabIndex={i === focusIdx ? 0 : -1}
                          aria-label={describe(d)}
                          onFocus={() => {
                            setFocusIdx(i);
                            show(i);
                          }}
                          onBlur={() => setTip(null)}
                          onMouseEnter={() => show(i)}
                          onMouseLeave={() => setTip((x) => (x?.i === i ? null : x))}
                          onKeyDown={(e) => onKey(e, i)}
                          className="rounded-[4px] outline-none hover:ring-1 hover:ring-foreground/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card"
                          style={{ gridColumn: col + 1, gridRow: row + 1, ...cellStyle(d.pct) }}
                        />
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {tip && tipDay && (
        <div
          role="tooltip"
          aria-hidden
          className="pointer-events-none absolute z-10 flex -translate-x-1/2 -translate-y-full flex-col gap-1 rounded-md border bg-popover px-3 py-2 text-xs whitespace-nowrap text-popover-foreground shadow-lg"
          style={{ left: tip.x, top: tip.y - 6 }}
        >
          <span className="text-muted-foreground">{fullDate(tipDay.date)}</span>
          <span className="flex items-baseline gap-3 font-semibold">
            {tipDay.pct == null ? <span className="font-normal text-muted-foreground">Not measured</span> : <Delta value={tipDay.pct} />}
            {tipDay.pnl != null && <Delta value={tipDay.pnl} kind="money" />}
          </span>
        </div>
      )}

      <Legend />
    </div>
  );
}

function Legend() {
  const swatch = (pct: number) => <span key={pct} aria-hidden className="size-2.5 rounded-[3px]" style={cellStyle(pct)} />;
  const steps = [0.025, 0.015, 0.0075, 0.002];
  return (
    <div className="flex items-center gap-2 text-[11px] text-faint">
      <span>Loss</span>
      <span className="flex gap-[3px]">
        {steps.map((s) => swatch(-s))}
        {swatch(0)}
        {[...steps].reverse().map(swatch)}
      </span>
      <span>Gain</span>
      <span className="sr-only">Darker cells moved more: under 0.5%, 0.5 to 1%, 1 to 2%, and 2% or more.</span>
    </div>
  );
}
