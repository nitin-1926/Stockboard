// Kite MCP read wrappers. The hosted server also exposes order/GTT/alert writes and
// `session logout` (U1 findings), so every call goes through the (tool, mode) allowlist
// below, checked before any network I/O. Item schemas come from the U1 fixtures because
// the server's own outputSchemas are untyped; drift fails loudly naming tool:mode.
import { z } from "zod";
import { McpToolError, type ToolCaller } from "../client";

const ALLOWED: Record<string, readonly string[]> = {
  portfolio: ["holdings", "positions", "margins", "profile"],
  orders: ["all_trades", "list"],
  market: ["ltp", "quote", "ohlc", "historical", "search"],
};

/** The only way to call a Kite tool. Anything off the read-only allowlist throws without a request. */
export function kiteCall(call: ToolCaller, tool: string, mode: string, args: Record<string, unknown> = {}) {
  if (!Object.hasOwn(ALLOWED, tool) || !ALLOWED[tool].includes(mode)) {
    throw new Error(`Kite ${tool}:${mode} is not on the read-only allowlist`);
  }
  return call(tool, { ...args, mode });
}

function parse<S extends z.ZodType>(schema: S, data: unknown, tool: string, mode: string): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new McpToolError(tool, mode, `schema drift: ${z.prettifyError(r.error)}`);
  return r.data;
}

const PAGE = 500; // server max
async function paginate<S extends z.ZodType>(call: ToolCaller, tool: string, mode: string, row: S, args = {}) {
  const page = z.object({ data: z.array(row), pagination: z.object({ has_more: z.boolean() }) });
  const out: z.infer<S>[] = [];
  for (let from = 0; ; ) {
    const p = parse(page, await kiteCall(call, tool, mode, { ...args, from, limit: PAGE }), tool, mode);
    out.push(...p.data);
    if (!p.pagination.has_more) return out;
    if (p.data.length === 0) throw new McpToolError(tool, mode, "has_more with an empty page");
    from += p.data.length;
  }
}

const num = z.number();
const str = z.string();

const holdingRow = z.object({
  tradingsymbol: str,
  exchange: str,
  isin: str,
  quantity: num,
  opening_quantity: num,
  used_quantity: num,
  t1_quantity: num,
  average_price: num,
  last_price: num,
  close_price: num,
});

/**
 * `qty` is Kite's `quantity`: today's sells already deducted (= openingQty - usedQty); excludes
 * `t1Qty` and today's buys (those show only as net CNC positions). U10 composes the snapshot qty.
 */
export type BrokerHolding = {
  brokerSymbol: string;
  exchange: string;
  isin: string;
  qty: number;
  openingQty: number;
  usedQty: number;
  t1Qty: number;
  avgPrice: number;
  lastPrice: number;
  closePrice: number;
};

export async function getHoldings(call: ToolCaller): Promise<BrokerHolding[]> {
  const rows = await paginate(call, "portfolio", "holdings", holdingRow, { type: "full" });
  return rows.map((h) => ({
    brokerSymbol: h.tradingsymbol,
    exchange: h.exchange,
    isin: h.isin,
    qty: h.quantity,
    openingQty: h.opening_quantity,
    usedQty: h.used_quantity,
    t1Qty: h.t1_quantity,
    avgPrice: h.average_price,
    lastPrice: h.last_price,
    closePrice: h.close_price,
  }));
}

const positionRow = z.object({
  view: z.enum(["day", "net"]),
  tradingsymbol: str,
  exchange: str,
  product: str,
  quantity: num,
  average_price: num,
  last_price: num,
  buy_quantity: num,
  buy_price: num,
  sell_quantity: num,
  sell_price: num,
});

/** One row per instrument per view; never sum `day` and `net`. Match to holdings by symbol/ISIN, not exchange. */
export type BrokerPosition = {
  view: "day" | "net";
  brokerSymbol: string;
  exchange: string;
  product: string;
  qty: number;
  avgPrice: number;
  lastPrice: number;
  buyQty: number;
  buyAvg: number;
  sellQty: number;
  sellAvg: number;
};

export async function getPositions(call: ToolCaller): Promise<BrokerPosition[]> {
  const rows = await paginate(call, "portfolio", "positions", positionRow);
  return rows.map((p) => ({
    view: p.view,
    brokerSymbol: p.tradingsymbol,
    exchange: p.exchange,
    product: p.product,
    qty: p.quantity,
    avgPrice: p.average_price,
    lastPrice: p.last_price,
    buyQty: p.buy_quantity,
    buyAvg: p.buy_price,
    sellQty: p.sell_quantity,
    sellAvg: p.sell_price,
  }));
}

const tradeRow = z.object({
  trade_id: str.min(1),
  order_id: str,
  exchange: str,
  tradingsymbol: str,
  product: str,
  transaction_type: z.enum(["BUY", "SELL"]),
  quantity: num,
  average_price: num,
  // Ingest needs the offset (it derives the market-local trade date from it).
  fill_timestamp: z.iso.datetime({ offset: true }).refine((s) => !s.endsWith("Z"), "offset required"),
});

export type BrokerTrade = {
  tradeId: string;
  orderId: string;
  exchange: string;
  symbol: string;
  /** CNC (delivery), MIS (intraday), ... U10 keeps CNC only. */
  product: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  /** ISO 8601 with Kite's +05:30 offset. */
  executedAt: string;
};

/** Today's fills (`orders` all_trades; `trades` mode is one order only). One order can have several. */
export async function getTodayTrades(call: ToolCaller): Promise<BrokerTrade[]> {
  const rows = await paginate(call, "orders", "all_trades", tradeRow);
  return rows.map((t) => ({
    tradeId: t.trade_id,
    orderId: t.order_id,
    exchange: t.exchange,
    symbol: t.tradingsymbol,
    product: t.product,
    side: t.transaction_type,
    qty: t.quantity,
    price: t.average_price,
    executedAt: t.fill_timestamp,
  }));
}

const segment = z.object({
  enabled: z.boolean(),
  net: num,
  available: z.object({ cash: num, collateral: num, live_balance: num, opening_balance: num }),
  utilised: z.object({ debits: num }),
});
const marginsSchema = z.object({ equity: segment, commodity: segment });

export type MarginSegment = {
  enabled: boolean;
  net: number;
  cash: number;
  collateral: number;
  liveBalance: number;
  openingBalance: number;
  utilised: number;
};
export type BrokerMargins = { equity: MarginSegment; commodity: MarginSegment };

export async function getMargins(call: ToolCaller): Promise<BrokerMargins> {
  const m = parse(marginsSchema, await kiteCall(call, "portfolio", "margins"), "portfolio", "margins");
  const seg = (s: z.infer<typeof segment>): MarginSegment => ({
    enabled: s.enabled,
    net: s.net,
    cash: s.available.cash,
    collateral: s.available.collateral,
    liveBalance: s.available.live_balance,
    openingBalance: s.available.opening_balance,
    utilised: s.utilised.debits,
  });
  return { equity: seg(m.equity), commodity: seg(m.commodity) };
}

const profileSchema = z.object({ user_id: str.min(1), broker: str });

/** Cheapest authenticated read; used to verify a fresh token. Holds PII: never log it. */
export async function getProfile(call: ToolCaller) {
  const p = parse(profileSchema, await kiteCall(call, "portfolio", "profile"), "portfolio", "profile");
  return { userId: p.user_id, broker: p.broker };
}

const ltpSchema = z.object({ data: z.record(str, z.object({ last_price: num })) });

/** `EXCH:SYMBOL` → last price. Instruments Kite doesn't know are simply absent. */
export async function getLtp(call: ToolCaller, instruments: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (let i = 0; i < instruments.length; i += PAGE) {
    const args = { instruments: instruments.slice(i, i + PAGE) };
    const r = parse(ltpSchema, await kiteCall(call, "market", "ltp", args), "market", "ltp");
    for (const [k, v] of Object.entries(r.data)) out[k] = v.last_price;
  }
  return out;
}
