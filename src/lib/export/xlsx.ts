// XLSX via exceljs: one worksheet per sheet (holdings → Holdings + Summary). Numbers stay
// numeric cells with a display format (percentages are fractions shown as 0.00%), dates
// are real date cells, and every text cell is formula-neutralized and written as a plain
// string value: exceljs only emits a formula for an explicit { formula } object, so a
// string starting with "=" can never become one here.
import ExcelJS from "exceljs";
import { neutralize } from "./sanitize";
import type { Cell, Kind, Sheet } from "./sheets";

const FORMAT: Record<Kind, string | undefined> = {
  text: undefined,
  int: "0",
  qty: "General",
  money: "#,##0.00",
  price: "#,##0.00##",
  pct: "0.00%",
  date: "yyyy-mm-dd",
};

const isoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function toXlsx(sheets: Sheet[]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Stockboard";
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.addRow(s.columns.map((c) => neutralize(c.header))).font = { bold: true };
    for (const row of s.rows) {
      const r = ws.addRow([]);
      row.forEach((c: Cell, i) => {
        const { v, kind } = c !== null && typeof c === "object" ? c : { v: c, kind: s.columns[i].kind };
        if (v == null || (typeof v === "number" && !Number.isFinite(v))) return;
        const cell = r.getCell(i + 1);
        if (typeof v === "number") {
          cell.value = v;
          cell.numFmt = FORMAT[kind] ?? "General";
        } else if (kind === "date" && isoDate(v)) {
          cell.value = new Date(`${v}T00:00:00Z`); // exceljs serializes dates in UTC
          cell.numFmt = FORMAT.date!;
        } else {
          cell.value = neutralize(v);
        }
      });
    }
    ws.columns.forEach((col, i) => {
      const longest = Math.max(s.columns[i]?.header.length ?? 0, ...s.rows.slice(0, 200).map((r) => String(cellText(r[i])).length));
      col.width = Math.min(48, Math.max(8, longest + 2));
    });
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

const cellText = (c: Cell | undefined) => (c !== null && typeof c === "object" ? (c.v ?? "") : (c ?? ""));
