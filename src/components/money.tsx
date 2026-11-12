// Amount, percent and delta rendering. Server- and client-safe (no hooks).
// A missing value (redacted for a hide-amounts actor, or not computable) renders a faint hyphen.
// Direction is carried by a +/- sign plus screen-reader text, never by color alone.
import { cn } from "@/lib/utils";

export type Ccy = "INR" | "USD";
type Num = number | null | undefined;

const nf = new Map<string, Intl.NumberFormat>();
function fmt(locale: string, opts: Intl.NumberFormatOptions) {
  const key = locale + JSON.stringify(opts);
  let f = nf.get(key);
  if (!f) nf.set(key, (f = new Intl.NumberFormat(locale, opts)));
  return f;
}

/** en-IN (lakh/crore grouping) for INR, en-US for USD. */
export function formatMoney(value: number, currency: Ccy, { decimals, compact }: { decimals?: number; compact?: boolean } = {}) {
  const d = decimals ?? (currency === "INR" ? 0 : 2);
  return fmt(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: compact ? 0 : d,
    maximumFractionDigits: compact ? 2 : d,
    notation: compact ? "compact" : "standard",
  }).format(value);
}

/** `value` is a fraction: 0.1325 → "13.25%". */
export const formatPercent = (value: number, decimals = 2) =>
  fmt("en-IN", { style: "percent", minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);

export const formatQty = (value: number) => fmt("en-IN", { maximumFractionDigits: 4 }).format(value);

const IST: Intl.DateTimeFormatOptions = { timeZone: "Asia/Kolkata" };
/** "11 Nov, 3:30 pm IST" */
export const formatAsOf = (iso: string) =>
  `${new Date(iso).toLocaleString("en-IN", { ...IST, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} IST`;
/** "11 Nov 2026" for an ISO date or timestamp. */
export const formatDate = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString("en-IN", {
    timeZone: iso.length === 10 ? "UTC" : "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

/** 12 → "12d", 200 → "6mo", 500 → "1y 4mo". */
export function formatHeld(days: number) {
  if (days < 31) return `${days}d`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return `${months}mo`;
  const y = Math.floor(months / 12);
  const m = months % 12;
  return m ? `${y}y ${m}mo` : `${y}y`;
}

export function Dash({ label = "Not available" }: { label?: string }) {
  return (
    <span className="text-faint" aria-label={label} title={label}>
      -
    </span>
  );
}

export function Money({
  value,
  currency = "INR",
  decimals,
  compact,
  className,
}: {
  value: Num;
  currency?: Ccy;
  decimals?: number;
  compact?: boolean;
  className?: string;
}) {
  if (value == null) return <Dash />;
  return <span className={cn("num", className)}>{formatMoney(value, currency, { decimals, compact })}</span>;
}

export function Percent({ value, decimals, className }: { value: Num; decimals?: number; className?: string }) {
  if (value == null) return <Dash />;
  return <span className={cn("num", className)}>{formatPercent(value, decimals)}</span>;
}

/** Signed change: +gain / -loss in the palette colors. */
export function Delta({
  value,
  kind = "percent",
  currency = "INR",
  decimals,
  className,
}: {
  value: Num;
  kind?: "percent" | "money";
  currency?: Ccy;
  decimals?: number;
  className?: string;
}) {
  if (value == null) return <Dash />;
  const abs = Math.abs(value);
  const text = kind === "percent" ? formatPercent(abs, decimals) : formatMoney(abs, currency, { decimals });
  // Rounds to zero → flat; no glyph, no color.
  const flat = text === (kind === "percent" ? formatPercent(0, decimals) : formatMoney(0, currency, { decimals }));
  if (flat) return <span className={cn("num text-muted-foreground", className)}>{text}</span>;
  const up = value > 0;
  return (
    <span className={cn("num whitespace-nowrap", up ? "text-gain" : "text-loss", className)}>
      <span aria-hidden>{up ? "+" : "\u2212"}</span>
      <span className="sr-only">{up ? "up " : "down "}</span>
      {text}
    </span>
  );
}
