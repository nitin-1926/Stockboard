// Server-only. Export = the same view modules the pages use (loader + pure builder +
// redaction), flattened into format-neutral sheets that csv.ts / xlsx.ts serialize. Numbers
// and redaction therefore match the pages by construction: an amount a hide-amounts actor
// can't see is already absent from the DTO, and its column is dropped, never blanked.
import { type Actor, can } from "@/lib/auth/access";
import { isoInMarket } from "@/lib/ledger/queries";
import { type Alpha, BENCHMARK_LABEL, buildBucketsView, type BucketsInputs, type BucketsView, loadBucketsInputs } from "@/lib/views/buckets";
import { buildHoldingsView, type HoldingsView, loadHoldingsInputs, type TotalsDto } from "@/lib/views/holdings";
import { buildTrades, loadTradesInputs, type TradesInputs, type TradesView } from "@/lib/views/trades";

export const EXPORT_KINDS = ["holdings", "buckets", "trades", "ledger"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

/** pct = a fraction (0.12 = 12%); date = ISO yyyy-mm-dd. */
export type Kind = "text" | "int" | "qty" | "money" | "price" | "pct" | "date";
export type Value = string | number | null;
/** A cell; `{ v, kind }` overrides its column's kind (Summary sheet). */
export type Cell = Value | { v: Value; kind: Kind };
export interface Column {
  header: string;
  kind: Kind;
}
export interface Sheet {
  name: string;
  columns: Column[];
  rows: Cell[][];
}

/** Columns whose cell is `undefined` for this actor (redacted amount) are dropped whole. */
type Spec<R> = [header: string, kind: Kind, get: (r: R) => Value | undefined, amount?: true];
function table<R>(name: string, specs: Spec<R>[], rows: R[], hideAmounts: boolean): Sheet {
  const keep = specs.filter((s) => !(hideAmounts && s[3]));
  return {
    name,
    columns: keep.map(([header, kind]) => ({ header, kind })),
    rows: rows.map((r) => keep.map(([, , get]) => get(r) ?? null)),
  };
}

// ---------- holdings ----------

const sumWeight = (v: HoldingsView, market: "IN" | "US") =>
  v.rows.filter((r) => r.market === market).reduce((s, r) => s + (r.weightPct ?? 0), 0);

export function holdingsSheets(v: HoldingsView, now: Date): Sheet[] {
  const bucketName = new Map(v.buckets.map((b) => [b.id, b.name]));
  type R = HoldingsView["rows"][number];
  const holdings = table<R>(
    "Holdings",
    [
      ["Symbol", "text", (r) => r.symbol],
      ["Name", "text", (r) => r.name],
      ["Market", "text", (r) => r.market],
      ["Exchange", "text", (r) => r.exchange],
      ["Currency", "text", (r) => r.currency],
      ["Qty", "qty", (r) => r.qty, true],
      ["Avg Cost", "price", (r) => r.avgCost],
      ["LTP", "price", (r) => r.price],
      ["Invested (INR)", "money", (r) => r.investedInr, true],
      ["Value (INR)", "money", (r) => r.valueInr, true],
      ["P&L (INR)", "money", (r) => r.pnlInr, true],
      // Same as the page's default INR view: US rows show the INR return.
      ["Return %", "pct", (r) => (r.currency === "USD" ? r.returnInrPct : r.returnPct)],
      ["Day %", "pct", (r) => r.dayChangePct],
      ["Weight %", "pct", (r) => r.weightPct],
      ["Held since", "date", (r) => r.heldSince],
      ["LTCG", "text", (r) => (r.ltcg.allLongTerm ? "Yes" : r.ltcg.nextEligible ? `No (next ${r.ltcg.nextEligible})` : "No")],
      ["Buckets", "text", (r) => r.bucketIds.map((id) => bucketName.get(id) ?? "").filter(Boolean).join(", ")],
    ],
    v.rows,
    v.amountsHidden,
  );

  const t = v.totals;
  const money = (label: string, x: number | undefined): Cell[][] => (x === undefined ? [] : [[label, { v: x, kind: "money" }]]);
  const pct = (label: string, x: number | null | undefined): Cell[][] => [[label, { v: x ?? null, kind: "pct" }]];
  const market = (label: string, m: TotalsDto) => [
    ...money(`${label} invested (INR)`, m.investedInr),
    ...money(`${label} value (INR)`, m.valueInr),
    ...money(`${label} P&L (INR)`, m.pnlInr),
    ...pct(`${label} return %`, m.returnPct),
  ];
  const summary: Sheet = {
    name: "Summary",
    columns: [
      { header: "Metric", kind: "text" },
      { header: "Value", kind: "text" },
    ],
    rows: [
      ["Holdings", { v: t.all.count, kind: "int" }],
      ["Priced holdings", { v: t.all.pricedCount, kind: "int" }],
      ...money("Invested (INR)", t.all.investedInr),
      ...money("Value (INR)", t.all.valueInr),
      ...money("P&L (INR)", t.all.pnlInr),
      ...pct("Return %", t.all.returnPct),
      ...money("Day change (INR)", t.all.dayChangeInr),
      ...pct("Day %", t.all.dayChangePct),
      ...market("India", t.IN),
      ...pct("India weight %", sumWeight(v, "IN")),
      ...market("US", t.US),
      ...money("US invested (USD)", t.US.investedUsd),
      ...money("US value (USD)", t.US.valueUsd),
      ...pct("US return in USD %", t.US.returnUsdPct),
      ...pct("US FX contribution %", t.US.fxContributionPct),
      ...pct("US weight %", sumWeight(v, "US")),
      ["USD/INR", { v: v.fx?.usdInr ?? null, kind: "price" }],
      ["USD/INR as of", { v: v.fx?.date ?? null, kind: "date" }],
      ["Prices as of", t.all.priceAsOf],
      ["Exported at", now.toISOString()],
    ],
  };
  return [holdings, summary];
}

// ---------- buckets ----------

const alphaCell = (alpha: Alpha[], market: "IN" | "US"): Value => {
  const a = alpha.find((x) => x.market === market);
  if (!a) return null;
  return a.status === "ok" ? a.alpha : a.status; // "pending" | "na"
};

export function bucketsSheet(v: BucketsView, inputs: Pick<BucketsInputs, "members" | "instruments">): Sheet {
  const members = (id: string) =>
    [
      ...new Set(
        inputs.members
          .filter((m) => m.bucketId === id)
          .map((m) => `${inputs.instruments[m.instrumentId]?.symbol ?? "?"}${m.kind === "watch_item" ? " (paper)" : ""}`),
      ),
    ]
      .sort()
      .join(", ");
  type R = BucketsView["buckets"][number];
  return table<R>(
    "Buckets",
    [
      ["Bucket", "text", (b) => b.name],
      ["Description", "text", (b) => b.description],
      ["Created by", "text", (b) => b.createdBy],
      ["Real members", "int", (b) => b.real.count],
      ["Invested (INR)", "money", (b) => b.real.costInr, true],
      ["Value (INR)", "money", (b) => b.real.valueInr, true],
      ["Realized (INR)", "money", (b) => b.real.realizedInr, true],
      ["Dividends net (INR)", "money", (b) => b.real.dividendsNetInr, true],
      ["Total return (INR)", "money", (b) => b.real.totalReturnInr, true],
      ["Real return %", "pct", (b) => b.real.returnPct],
      // XIRR is shown from one year; under that the page shows the absolute return only.
      ["Real XIRR %", "pct", (b) => (b.real.useAbsolute ? null : b.real.xirr)],
      ["Realized %", "pct", (b) => b.real.realizedPct],
      ["Paper members", "int", (b) => b.paper.count],
      ["Paper return %", "pct", (b) => b.paper.returnPct],
      ["Paper annualized %", "pct", (b) => (b.paper.useAbsolute ? null : b.paper.annualizedPct)],
      ["Combined return %", "pct", (b) => b.combined.returnPct],
      ["Combined XIRR %", "pct", (b) => (b.combined.useAbsolute ? null : b.combined.xirr)],
      [`Alpha vs ${BENCHMARK_LABEL.IN} %`, "pct", (b) => alphaCell(b.alpha, "IN")],
      [`Alpha vs ${BENCHMARK_LABEL.US} %`, "pct", (b) => alphaCell(b.alpha, "US")],
      ["Members", "text", (b) => members(b.id)],
    ],
    v.buckets,
    v.amountsHidden,
  );
}

// ---------- trades and ledger ----------

const TYPE_LABEL = { buy: "Buy", sell: "Sell", opening: "Opening", dividend: "Dividend", split: "Split", bonus: "Bonus" } as const;
type TradeR = TradesView["rows"][number];
const tradeCols: Spec<TradeR>[] = [
  ["Date", "date", (r) => r.date],
  ["Symbol", "text", (r) => r.symbol],
  ["Market", "text", (r) => r.market],
  ["Side", "text", (r) => TYPE_LABEL[r.type]],
  ["Qty", "qty", (r) => r.qty, true],
  ["Price", "price", (r) => r.price],
  ["Currency", "text", (r) => r.currency],
  ["Ratio", "text", (r) => r.ratio],
  ["Source", "text", (r) => r.source],
  ["Approximate", "text", (r) => (r.approximate ? "Yes" : "No")],
];

export const tradesSheet = (v: TradesView): Sheet => table("Trades", tradeCols, v.rows, v.amountsHidden);

/** Owner only: every event, superseded ones included, with its source ref. */
export function ledgerSheet(v: TradesView, inputs: Pick<TradesInputs, "events">): Sheet {
  const ev = new Map(inputs.events.map((e) => [e.id, e]));
  return table(
    "Ledger",
    [
      ...tradeCols,
      ["Executed at", "text", (r) => r.executedAt],
      ["Ex-date", "date", (r) => r.exDate],
      ["FX rate INR", "price", (r) => ev.get(r.id)?.fxRateInr ?? null],
      ["Amount (INR)", "money", (r) => r.amountInr, true],
      ["Status", "text", (r) => (r.superseded ? "superseded" : "live")],
      ["Replaced by", "text", (r) => r.replacedBy.join(", ")],
      ["Source ref", "text", (r) => ev.get(r.id)?.sourceRef ?? null],
      ["Event id", "text", (r) => r.id],
    ],
    v.rows,
    v.amountsHidden,
  );
}

// ---------- loader ----------

const ALL = { market: "all", type: "all" } as const;

/** Loads with the pages' own loaders and builders. Ledger is owner-only (the route checks first). */
export async function exportSheets(kind: ExportKind, actor: Actor, now: Date): Promise<Sheet[]> {
  switch (kind) {
    case "holdings":
      return holdingsSheets(buildHoldingsView(await loadHoldingsInputs(now), actor), now);
    case "buckets": {
      const inputs = await loadBucketsInputs(now);
      return [bucketsSheet(buildBucketsView(inputs, actor), inputs)];
    }
    case "trades":
      return [tradesSheet(buildTrades(await loadTradesInputs(), actor, { ...ALL, history: false }, Infinity))];
    case "ledger": {
      if (!can(actor, "manage")) throw new Error("Forbidden");
      const inputs = await loadTradesInputs();
      return [ledgerSheet(buildTrades(inputs, actor, { ...ALL, history: true }, Infinity), inputs)];
    }
  }
}

/** `stockboard-<kind>-YYYY-MM-DD.<ext>`, dated in India time. */
export const exportFilename = (kind: ExportKind, ext: "csv" | "xlsx", now: Date) =>
  `stockboard-${kind}-${isoInMarket(now, "INR").slice(0, 10)}.${ext}`;
