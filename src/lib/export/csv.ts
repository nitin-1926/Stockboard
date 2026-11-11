// RFC 4180 CSV of one sheet: CRLF line ends, a field with a comma, quote, CR or LF is
// quoted and its quotes doubled. Text is formula-neutralized first. A UTF-8 BOM lets
// Excel read ₹ and non-ASCII names correctly. Percentages are written as percent
// numbers (12.5 for 12.5%), matching the "%" in their headers.
import { neutralize } from "./sanitize";
import type { Cell, Kind, Sheet } from "./sheets";

const quote = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);

function field(c: Cell, colKind: Kind): string {
  const { v, kind } = c !== null && typeof c === "object" ? c : { v: c, kind: colKind };
  if (v == null) return "";
  if (typeof v === "string") return quote(neutralize(v));
  if (!Number.isFinite(v)) return "";
  // Trim float noise (0.30000000000000004) without losing real precision.
  return String(kind === "pct" ? +(v * 100).toFixed(6) : +v.toFixed(8));
}

export function toCsv(sheet: Sheet): string {
  const lines = [
    sheet.columns.map((c) => quote(neutralize(c.header))).join(","),
    ...sheet.rows.map((r) => r.map((c, i) => field(c, sheet.columns[i].kind)).join(",")),
  ];
  return `﻿${lines.join("\r\n")}\r\n`;
}
