// pnpm demo:seed: clearly-marked demo portfolio for visual checks of Overview/Holdings.
// Every row is findable: instruments `DEMO_*`, sync run job 'demo', ledger source_ref
// 'demo:*', FX source 'demo'. Re-running replaces it; `pnpm demo:clean` removes it all.
// Never run against production.
import { pool } from "@/db";
import { cleanDemo } from "./demo-clean.mjs";

type H = {
  sym: string;
  name: string;
  market: "IN" | "US";
  exchange: string;
  lots: { date: string; qty: number; price: number; fx?: number; approximate?: boolean }[];
  price: number | null; // null → price_unavailable
  prev: number;
  t1?: number;
  etf?: boolean;
};

const HOLDINGS: H[] = [
  { sym: "INFY", name: "Infosys", market: "IN", exchange: "NSE", lots: [{ date: "2025-02-10", qty: 40, price: 1480 }], price: 1612.4, prev: 1598.1 },
  {
    sym: "HDFCBANK",
    name: "HDFC Bank",
    market: "IN",
    exchange: "NSE",
    lots: [
      { date: "2025-08-20", qty: 25, price: 1610 },
      { date: "2026-05-04", qty: 10, price: 1702.5 },
    ],
    price: 1688.2,
    prev: 1679.9,
  },
  {
    sym: "TCS",
    name: "Tata Consultancy Services",
    market: "IN",
    exchange: "NSE",
    lots: [
      { date: "2026-01-12", qty: 15, price: 3920 },
      { date: "__yesterday__", qty: 3, price: 3410 },
    ],
    price: 3398.6,
    prev: 3442.3,
    t1: 3,
  },
  { sym: "ITC", name: "ITC", market: "IN", exchange: "NSE", lots: [{ date: "2024-09-02", qty: 200, price: 412.35, approximate: true }], price: 438.1, prev: 436.45 },
  { sym: "TATAPOWER", name: "Tata Power", market: "IN", exchange: "NSE", lots: [{ date: "2026-06-15", qty: 100, price: 396.2 }], price: null, prev: 401 },
  { sym: "NIFTYETF", name: "Nifty 50 ETF", market: "IN", exchange: "NSE", etf: true, lots: [{ date: "2025-11-05", qty: 150, price: 268.4 }], price: 289.05, prev: 287.6 },
  { sym: "AAPL", name: "Apple", market: "US", exchange: "NASDAQ", lots: [{ date: "2024-12-02", qty: 12, price: 187.4, fx: 84.7 }], price: 241.3, prev: 238.9 },
  { sym: "MSFT", name: "Microsoft", market: "US", exchange: "NASDAQ", lots: [{ date: "2025-07-15", qty: 5, price: 412, fx: 85.9 }], price: 498.2, prev: 503.6 },
  { sym: "VOO", name: "Vanguard S&P 500 ETF", market: "US", exchange: "NYSE", etf: true, lots: [{ date: "2025-03-03", qty: 8, price: 452, fx: 87.1 }], price: 611, prev: 607.25 },
];

const iso = (d: Date) => d.toISOString().slice(0, 10);
function prevWeekday(d: Date) {
  const x = new Date(d);
  do x.setUTCDate(x.getUTCDate() - 1);
  while (x.getUTCDay() === 0 || x.getUTCDay() === 6);
  return x;
}

await cleanDemo();
const now = new Date();
const d1 = prevWeekday(now);
const d2 = prevWeekday(d1);
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);

const fxNow = Number((await q(`SELECT usd_inr FROM fx_daily ORDER BY date DESC LIMIT 1`)).rows[0]?.usd_inr ?? 93.7);
await q(`INSERT INTO fx_daily (date, usd_inr, source) VALUES ($1, $2, 'demo') ON CONFLICT (date) DO NOTHING`, [iso(now), fxNow]);

const run = (
  await q(`INSERT INTO sync_runs (job, status, finished_at, counts) VALUES ('demo', 'completed', now(), '{"demo":1}') RETURNING id`)
).rows[0].id as string;

for (const h of HOLDINGS) {
  const usd = h.market === "US";
  const inst = (
    await q(
      `INSERT INTO instruments (market, exchange, broker_symbol, name, currency, asset_class, price_unavailable)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [h.market, h.exchange, `DEMO_${h.sym}`, `${h.name} (demo)`, usd ? "USD" : "INR", h.etf ? "etf" : "equity", h.price == null],
    )
  ).rows[0].id as string;

  let qty = 0;
  let cost = 0;
  for (const [i, l] of h.lots.entries()) {
    const date = l.date === "__yesterday__" ? iso(d1) : l.date;
    await q(
      `INSERT INTO ledger_events (instrument_id, broker, type, date, qty, price, currency, fx_rate_inr, source, source_ref, approximate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [inst, usd ? "indmoney" : "kite", l.approximate ? "opening" : "buy", date, l.qty, l.price, usd ? "USD" : "INR",
       usd ? (l.fx ?? fxNow) : 1, l.approximate ? "opening" : "manual", `demo:${h.sym}:${i}`, !!l.approximate],
    );
    qty += l.qty;
    cost += l.qty * l.price;
  }

  await q(
    `INSERT INTO holding_snapshots (run_id, broker, instrument_id, taken_at, qty, t1_qty, avg_price, ltp)
     VALUES ($1, $2, $3, now(), $4, $5, $6, $7)`,
    [run, usd ? "indmoney" : "kite", inst, qty, h.t1 ?? 0, (cost / qty).toFixed(4), h.price],
  );
  if (h.price != null) {
    // IN priced at today's close (10:00 UTC = 15:30 IST); US at seed time.
    const asOf = usd ? now : new Date(`${iso(now)}T10:00:00Z`);
    await q(`INSERT INTO price_latest (instrument_id, price, as_of, source) VALUES ($1, $2, $3, 'yahoo')`, [inst, h.price, asOf]);
  }
  await q(`INSERT INTO prices_daily (instrument_id, date, close) VALUES ($1, $2, $3), ($1, $4, $5)`, [
    inst, iso(d1), h.prev, iso(d2), (h.prev * 0.99).toFixed(2),
  ]);
}

console.log(`demo seeded: ${HOLDINGS.length} holdings, run ${run}, prev closes ${iso(d2)} and ${iso(d1)}`);
await pool.end();
