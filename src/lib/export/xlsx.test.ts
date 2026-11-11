import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { Actor } from "@/lib/auth/access";
import { type BucketsInputs, buildBucketsView } from "@/lib/views/buckets";
import { buildHoldingsView, type HoldingInput } from "@/lib/views/holdings";
import { toCsv } from "./csv";
import { bucketsSheet, holdingsSheets } from "./sheets";
import { toXlsx } from "./xlsx";

const owner: Actor = { kind: "owner", email: "o@example.com", hideAmounts: false, via: "session" };
const hidden: Actor = { kind: "viewer", hideAmounts: true, via: "share-link" };
const NOW = new Date("2026-11-11T06:00:00Z");
const AT = new Date("2026-11-11T05:45:00Z");

const HYPERLINK = '=HYPERLINK("http://x","y")';
const CMD = "+cmd|' /C calc'!A0";

function holding(symbol: string, { qty, cost, price, ...o }: Partial<Omit<HoldingInput, "price">> & { qty: number; cost: number; price: number }): HoldingInput {
  const usd = o.currency === "USD";
  return {
    instrumentId: symbol,
    symbol,
    name: `${symbol} Ltd`,
    market: usd ? "US" : "IN",
    currency: usd ? "USD" : "INR",
    exchange: usd ? "NASDAQ" : "NSE",
    priceUnavailable: false,
    snapshot: { qty, t1Qty: 0, avgPrice: cost, ltp: null, takenAt: AT },
    lots: [
      {
        instrumentId: symbol,
        market: usd ? "US" : "IN",
        currency: usd ? "USD" : "INR",
        qty,
        costPerShare: cost,
        openDate: "2025-06-01",
        fxRateAtOpen: usd ? 83 : 1,
        closed: [],
        approximate: false,
      },
    ],
    price: { price, asOf: AT, source: "yahoo" },
    closes: [{ date: "2026-11-10", close: price * 0.99 }],
    ...o,
  };
}

const HOLDINGS = [
  holding("INFY", { qty: 10, cost: 1500, price: 1600, bucketIds: ["b1"] }),
  holding("LOSER", { qty: 5, cost: 200, price: 150, name: 'Foo, "Bar"\nBaz' }),
  holding("AAPL", { qty: 10, cost: 150, price: 150, currency: "USD" }),
];
const holdingsView = (actor: Actor) =>
  buildHoldingsView(
    {
      holdings: HOLDINGS,
      buckets: [{ id: "b1", name: HYPERLINK, color: "chart-1" }],
      fx: { usdInr: 94, date: "2026-11-11" },
      now: NOW,
    },
    actor,
  );

async function read(bytes: Uint8Array) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes.buffer as ArrayBuffer);
  return wb;
}
const headers = (ws: ExcelJS.Worksheet) => (ws.getRow(1).values as unknown[]).slice(1);
/** Summary sheet as { metric: cell }. */
const summary = (wb: ExcelJS.Workbook) => {
  const out = new Map<string, ExcelJS.Cell>();
  wb.getWorksheet("Summary")!.eachRow((r, i) => i > 1 && out.set(String(r.getCell(1).value), r.getCell(2)));
  return out;
};
const allCells = (wb: ExcelJS.Workbook) => {
  const cells: ExcelJS.Cell[] = [];
  wb.eachSheet((ws) => ws.eachRow((r) => r.eachCell((c) => cells.push(c))));
  return cells;
};

describe("holdings export", () => {
  it("XLSX has the expected columns and a Summary whose totals equal the view totals", async () => {
    const v = holdingsView(owner);
    const wb = await read(await toXlsx(holdingsSheets(v, NOW)));
    const ws = wb.getWorksheet("Holdings")!;
    expect(headers(ws)).toEqual([
      "Symbol", "Name", "Market", "Exchange", "Currency", "Qty", "Avg Cost", "LTP", "Invested (INR)", "Value (INR)",
      "P&L (INR)", "Return %", "Day %", "Weight %", "Held since", "LTCG", "Buckets",
    ]);
    expect(ws.rowCount).toBe(1 + v.rows.length);

    const s = summary(wb);
    const t = v.totals.all;
    expect(s.get("Holdings")!.value).toBe(3);
    expect(s.get("Invested (INR)")!.value).toBe(t.investedInr);
    expect(s.get("Value (INR)")!.value).toBe(t.valueInr);
    expect(s.get("P&L (INR)")!.value).toBe(t.pnlInr);
    expect(s.get("Return %")!.value).toBe(t.returnPct);
    expect(s.get("India value (INR)")!.value).toBe(v.totals.IN.valueInr);
    expect(s.get("US value (INR)")!.value).toBe(v.totals.US.valueInr);
    expect(s.get("USD/INR")!.value).toBe(94);
    expect(s.get("Exported at")!.value).toBe(NOW.toISOString());
    expect(s.get("Return %")!.numFmt).toBe("0.00%");

    // Row sums tie out to the Summary too (every fixture row is priced).
    const col = headers(ws).indexOf("Value (INR)") + 1;
    let sum = 0;
    ws.eachRow((r, i) => i > 1 && (sum += r.getCell(col).value as number));
    expect(sum).toBeCloseTo(t.valueInr!, 6);
    expect(allCells(wb).some((c) => c.type === ExcelJS.ValueType.Formula)).toBe(false);
  });

  it("hide-amounts: no Qty/Invested/Value/P&L columns or amount rows; prices and % stay", async () => {
    const v = holdingsView(hidden);
    const wb = await read(await toXlsx(holdingsSheets(v, NOW)));
    const h = headers(wb.getWorksheet("Holdings")!);
    for (const gone of ["Qty", "Invested (INR)", "Value (INR)", "P&L (INR)"]) expect(h).not.toContain(gone);
    for (const kept of ["Avg Cost", "LTP", "Return %", "Day %", "Weight %"]) expect(h).toContain(kept);
    const s = summary(wb);
    expect([...s.keys()].filter((k) => /\((INR|USD)\)/.test(k))).toEqual([]);
    expect(s.get("Return %")!.value).toBe(v.totals.all.returnPct);

    const csvHeader = toCsv(holdingsSheets(v, NOW)[0]).slice(1).split("\r\n")[0];
    expect(csvHeader).toBe("Symbol,Name,Market,Exchange,Currency,Avg Cost,LTP,Return %,Day %,Weight %,Held since,LTCG,Buckets");
  });
});

describe("formula injection and CSV quoting", () => {
  const bucketInputs: BucketsInputs = {
    buckets: [{ id: "b1", name: HYPERLINK, description: CMD, color: "chart-1", createdBy: "o@example.com" }],
    members: [],
    instruments: {},
    fx: null,
    fxSeries: {},
    benchmarks: { IN: null, US: null },
    withholding: { IN: 0.1, US: 0.25 },
    ownerEmail: "o@example.com",
    now: NOW,
  };

  it("XLSX: a formula-looking bucket name and note are string cells with a leading quote", async () => {
    const wb = await read(await toXlsx([bucketsSheet(buildBucketsView(bucketInputs, owner), bucketInputs)]));
    const row = wb.getWorksheet("Buckets")!.getRow(2);
    for (const [col, raw] of [[1, HYPERLINK], [2, CMD]] as const) {
      const c = row.getCell(col);
      expect(c.type).toBe(ExcelJS.ValueType.String);
      expect(c.value).toBe(`'${raw}`);
    }
    // The holdings Buckets column carries the same name.
    const hw = await read(await toXlsx(holdingsSheets(holdingsView(owner), NOW)));
    const ws = hw.getWorksheet("Holdings")!;
    const bcol = headers(ws).indexOf("Buckets") + 1;
    const infy = ws.getRows(2, ws.rowCount - 1)!.find((r) => r.getCell(1).value === "INFY")!;
    expect(infy.getCell(bcol).type).toBe(ExcelJS.ValueType.String);
    expect(infy.getCell(bcol).value).toBe(`'${HYPERLINK}`);
    // Negative numbers are numbers, not neutralized text.
    const loser = ws.getRows(2, ws.rowCount - 1)!.find((r) => r.getCell(1).value === "LOSER")!;
    const pnl = loser.getCell(headers(ws).indexOf("P&L (INR)") + 1);
    expect(pnl.type).toBe(ExcelJS.ValueType.Number);
    expect(pnl.value).toBe(-250);
    expect(allCells(hw).some((c) => c.type === ExcelJS.ValueType.Formula)).toBe(false);
  });

  it("CSV: same cells are emitted inert, numbers unquoted", () => {
    const csv = toCsv(bucketsSheet(buildBucketsView(bucketInputs, owner), bucketInputs));
    const row = csv.split("\r\n")[1];
    expect(row.startsWith(`"'=HYPERLINK(""http://x"",""y"")",'+cmd|' /C calc'!A0,`)).toBe(true);
    const holdingsCsv = toCsv(holdingsSheets(holdingsView(owner), NOW)[0]);
    expect(holdingsCsv).toContain(`"'${HYPERLINK.replaceAll('"', '""')}"`);
    expect(holdingsCsv).toMatch(/,-250,/); // P&L stays a plain negative number
  });

  it("CSV: RFC 4180 quoting of commas, quotes and newlines; CRLF rows; BOM", () => {
    const csv = toCsv({
      name: "t",
      columns: [
        { header: "a,b", kind: "text" },
        { header: "n", kind: "money" },
        { header: "p", kind: "pct" },
      ],
      rows: [
        ['Foo, "Bar"\nBaz', 0.1 + 0.2, 0.125],
        ["plain", null, null],
      ],
    });
    expect(csv).toBe(`﻿"a,b",n,p\r\n"Foo, ""Bar""\nBaz",0.3,12.5\r\nplain,,\r\n`);
    // The real holdings name goes through the same path.
    expect(toCsv(holdingsSheets(holdingsView(owner), NOW)[0])).toContain(`"Foo, ""Bar""\nBaz"`);
  });
});
