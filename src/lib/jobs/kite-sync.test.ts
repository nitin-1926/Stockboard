import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import allTrades from "@/lib/mcp/__fixtures__/kite-orders-all_trades.json";
import holdingsFx from "@/lib/mcp/__fixtures__/kite-portfolio-holdings.json";
import marginsFx from "@/lib/mcp/__fixtures__/kite-portfolio-margins.json";
import positionsFx from "@/lib/mcp/__fixtures__/kite-portfolio-positions.json";
import type { ToolCaller } from "@/lib/mcp/client";

// MCP, the headless login, connection status writes and Yahoo are mocked. The DB part runs on
// the real Neon dev DB with TEST_<tag>_ instruments (cleaned up) and a test job name, so real
// Kite rows, the kite connection row and kite-sync banners are never touched.
const mem = vi.hoisted(() => ({
  data: null as null | Record<string, unknown>,
  /** Throw SessionExpiredError on this many upcoming connections. */
  expire: 0,
}));

vi.mock("@/lib/mcp/client", async (orig) => {
  const real = await orig<typeof import("@/lib/mcp/client")>();
  return {
    ...real,
    withMcp: vi.fn(async (_url: string, _token: unknown, fn: (call: ToolCaller) => Promise<unknown>) => {
      if (mem.expire > 0) {
        mem.expire--;
        throw new real.SessionExpiredError("portfolio:holdings: kite session has expired");
      }
      return fn(async (tool, args) => {
        const r = mem.data?.[`${tool}:${args.mode}`];
        if (r === undefined) throw new Error(`unexpected ${tool}:${args.mode}`);
        return structuredClone(r);
      });
    }),
  };
});
vi.mock("@/lib/brokers/connections", async (orig) => ({
  ...(await orig<typeof import("@/lib/brokers/connections")>()),
  loadMcpTokens: vi.fn(async () => ({ access_token: "test-token" })),
  setStatus: vi.fn(async () => {}),
}));
vi.mock("@/lib/mcp/kite/headless-login", () => ({ kiteHeadlessLogin: vi.fn(async () => ({ expiresAt: new Date() })) }));
vi.mock("@/lib/market/prices", async (orig) => ({
  ...(await orig<typeof import("@/lib/market/prices")>()),
  refreshLatest: vi.fn(async () => ({ yahoo: 0, fallback: 0, unavailable: 0, kept: 0 })),
  backfillHistory: vi.fn(async () => ({ bars: 0, newEvents: 0, refetched: false })),
}));

const { db, pool } = await import("@/db");
const { holdingSnapshots, instruments, ledgerEvents, ledgerReviewQueue, marginsLatest, priceLatest, syncRuns } = await import("@/db/schema");
const { setStatus } = await import("@/lib/brokers/connections");
const { kiteHeadlessLogin } = await import("@/lib/mcp/kite/headless-login");
const { getHoldings, getPositions } = await import("@/lib/mcp/kite/tools");
const { isoInMarket } = await import("@/lib/ledger/queries");
const { runJob } = await import("./handler");
const { composeSnapshot, syncKite } = await import("./kite-sync");

const sc = <T,>(f: { structuredContent?: unknown }) => structuredClone(f.structuredContent) as T;
type Row = Record<string, unknown>;
const fixtureCaller = (byMode: Record<string, unknown>): ToolCaller => async (tool, args) => byMode[`${tool}:${args.mode}`];

describe("composeSnapshot (snapshot qty rule)", () => {
  const parse = async (holdings: unknown, positions: unknown) => {
    const call = fixtureCaller({ "portfolio:holdings": holdings, "portfolio:positions": positions });
    return composeSnapshot(await getHoldings(call), await getPositions(call));
  };

  it("scrubbed U1 fixtures: sells already out of holdings, BSE holding sold on NSE, new buy only in positions", async () => {
    const lines = await parse(sc(holdingsFx), sc(positionsFx));
    const by = new Map(lines.map((l) => [l.symbol, l]));
    expect(lines).toHaveLength(33); // 32 holdings + DDDD (positions only)
    // EEEE: held on BSE (opening 160, used 11 → quantity 149), sold on NSE (day row): not subtracted again.
    expect(by.get("EEEE")).toMatchObject({ exchange: "BSE", qty: 149, avgPrice: 969.16, topUp: false });
    // CCCC: quantity 6 = 103 − 97 sold today.
    expect(by.get("CCCC")).toMatchObject({ qty: 6, avgPrice: 679.74 });
    // DDDD: bought today, not in holdings → day CNC buy qty at the day buy average.
    expect(by.get("DDDD")).toMatchObject({ exchange: "NSE", qty: 144, avgPrice: 1429.99, t1Qty: 0, raw: { day: expect.any(Object) } });
    expect(by.get("DDDD")!.raw.holding).toBeUndefined();
    // Every other holding: quantity + t1 (no positions).
    expect(by.get("BBBB")).toMatchObject({ qty: 50, t1Qty: 0, avgPrice: 1028.86, ltp: 334.62 });
  });

  it("holding 10 + T+1 5 + day CNC buy 5 → 20, weighted avg; MIS ignored; net view never added", async () => {
    const h = sc<{ data: Row[] }>(holdingsFx);
    const p = sc<{ data: Row[] }>(positionsFx);
    const hold = { ...h.data[0], tradingsymbol: "X", quantity: 10, opening_quantity: 10, used_quantity: 0, t1_quantity: 5, average_price: 100 };
    const day = (o: Row) => ({ ...p.data[0], view: "day", tradingsymbol: "X", exchange: "NSE", product: "CNC", buy_quantity: 0, buy_price: 0, sell_quantity: 0, sell_price: 0, ...o });
    const lines = await parse(
      { data: [hold], pagination: { has_more: false } },
      {
        data: [
          day({ buy_quantity: 5, buy_price: 130 }),
          day({ product: "MIS", buy_quantity: 50, buy_price: 1 }),
          day({ view: "net", buy_quantity: 5, buy_price: 130 }),
          day({ tradingsymbol: "M", product: "MIS", buy_quantity: 7, buy_price: 10 }),
        ],
        pagination: { has_more: false },
      },
    );
    expect(lines).toHaveLength(1); // M (MIS only) never becomes a line
    expect(lines[0]).toMatchObject({ symbol: "X", qty: 20, t1Qty: 5, topUp: true });
    expect(lines[0].avgPrice).toBeCloseTo((15 * 100 + 5 * 130) / 20, 9);
  });

  it("bought and sold the same day → 0; sold with no holdings row → 0 at the sell average", async () => {
    const p = sc<{ data: Row[] }>(positionsFx);
    const day = (o: Row) => ({ ...p.data[0], view: "day", exchange: "NSE", product: "CNC", buy_quantity: 0, buy_price: 0, sell_quantity: 0, sell_price: 0, ...o });
    const lines = await parse(
      { data: [], pagination: { has_more: false } },
      {
        data: [
          day({ tradingsymbol: "Y", buy_quantity: 4, buy_price: 10, sell_quantity: 4, sell_price: 11 }),
          day({ tradingsymbol: "Z", sell_quantity: 3, sell_price: 50 }),
        ],
        pagination: { has_more: false },
      },
    );
    expect(lines.map((l) => [l.symbol, l.qty, l.avgPrice])).toEqual([
      ["Y", 0, 10],
      ["Z", 0, 50],
    ]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("syncKite (Neon, mocked MCP)", { timeout: 180_000 }, () => {
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const prefix = `TEST_${tag}_`;
  const job = `test-kite-sync-${tag}`;
  const S = (s: string) => prefix + s;
  const at = isoInMarket(new Date(Date.now() - 60_000), "INR");

  const hTpl = sc<{ data: Row[] }>(holdingsFx).data[0];
  const pTpl = sc<{ data: Row[] }>(positionsFx).data[0];
  const tTpl = sc<{ data: Row[] }>(allTrades).data[0];
  const H = (sym: string, o: Row) => ({
    ...hTpl,
    tradingsymbol: S(sym),
    exchange: "NSE",
    isin: `IN${tag}${sym}`,
    used_quantity: 0,
    t1_quantity: 0,
    ...o,
    opening_quantity: Number(o.quantity) + Number(o.used_quantity ?? 0),
  });
  const P = (sym: string, o: Row) => ({
    ...pTpl,
    view: "day",
    tradingsymbol: S(sym),
    exchange: "NSE",
    product: "CNC",
    buy_quantity: 0,
    buy_price: 0,
    sell_quantity: 0,
    sell_price: 0,
    ...o,
  });
  const T = (id: string, sym: string, side: "BUY" | "SELL", quantity: number, price: number, product = "CNC") => ({
    ...tTpl,
    trade_id: `${tag}${id}`,
    tradingsymbol: S(sym),
    exchange: "NSE",
    product,
    transaction_type: side,
    quantity,
    average_price: price,
    fill_timestamp: at,
  });
  const margins = sc<Row>(marginsFx);
  const kite = (holdings: Row[], positions: Row[], trades: Row[]) => {
    const page = (data: Row[]) => ({ data, pagination: { has_more: false } });
    mem.data = {
      "portfolio:holdings": page(holdings),
      "portfolio:positions": page(positions),
      "orders:all_trades": page(trades),
      "portfolio:margins": margins,
    };
  };
  const sync = () => runJob(job, ({ runId }) => syncKite(runId, { symbolPrefix: prefix }));

  const inst = async (sym: string) => (await db.select().from(instruments).where(eq(instruments.brokerSymbol, S(sym))))[0];
  const events = async (sym: string) => {
    const i = await inst(sym);
    return i ? db.select().from(ledgerEvents).where(eq(ledgerEvents.instrumentId, i.id)) : [];
  };
  const snaps = (runId: string) =>
    db
      .select({ sym: instruments.brokerSymbol, qty: holdingSnapshots.qty, t1: holdingSnapshots.t1Qty })
      .from(holdingSnapshots)
      .innerJoin(instruments, eq(instruments.id, holdingSnapshots.instrumentId))
      .where(eq(holdingSnapshots.runId, runId));
  const snapMap = async (runId: string) =>
    Object.fromEntries((await snaps(runId)).map((r) => [r.sym.slice(prefix.length), [Number(r.qty), Number(r.t1)]]));
  const brief = (es: { type: string; source: string; qty: string; sourceRef: string }[]) =>
    es.map((e) => `${e.source}:${e.type}:${Number(e.qty)}`).sort();

  let savedMargins: (typeof marginsLatest.$inferSelect)[] = [];
  const day1 = () =>
    kite(
      [
        H("A", { quantity: 10, average_price: 100, last_price: 110 }),
        H("B", { exchange: "BSE", quantity: 5, used_quantity: 5, average_price: 200, last_price: 210 }), // 5 of 10 sold today
        H("E", { quantity: 10, t1_quantity: 5, average_price: 50, last_price: 55 }),
      ],
      [
        P("A", { buy_quantity: 5, buy_price: 120, last_price: 110 }),
        P("B", { sell_quantity: 5, sell_price: 210 }), // sold on NSE, held under BSE
        P("C", { buy_quantity: 3, buy_price: 300, last_price: 305 }), // new buy, positions only
        P("D", { product: "MIS", buy_quantity: 7, buy_price: 10 }),
      ],
      [T("1", "A", "BUY", 5, 120), T("2", "B", "SELL", 5, 210), T("3", "C", "BUY", 3, 300), T("4", "D", "BUY", 7, 10, "MIS")],
    );

  beforeAll(async () => {
    savedMargins = await db.select().from(marginsLatest).where(eq(marginsLatest.broker, "kite"));
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mem.expire = 0;
  });
  afterAll(async () => {
    await db.delete(syncRuns).where(eq(syncRuns.job, job)); // cascades snapshots
    await db.delete(instruments).where(like(instruments.brokerSymbol, `${prefix}%`)); // events, review, prices
    await db.delete(marginsLatest).where(eq(marginsLatest.broker, "kite"));
    if (savedMargins.length) await db.insert(marginsLatest).values(savedMargins);
    const left = await db.select().from(instruments).where(like(instruments.brokerSymbol, `${prefix}%`));
    expect(left).toHaveLength(0);
    await pool.end();
  });

  let run1 = "";
  it("first sync: T+1 + today's buys in qty, openings exclude today's fills, MIS dropped, fill:<trade_id>", async () => {
    day1();
    const r = await sync();
    expect(r.status).toBe("completed");
    run1 = r.runId;
    expect(await snapMap(run1)).toEqual({ A: [15, 0], B: [5, 0], C: [3, 0], E: [15, 5] });
    expect(await inst("D")).toBeUndefined(); // MIS: no instrument, no fill
    expect((await inst("B")).exchange).toBe("BSE");

    expect(brief(await events("A"))).toEqual(["fill:buy:5", "opening:opening:10"]);
    expect(brief(await events("B"))).toEqual(["fill:sell:5", "opening:opening:10"]);
    expect(brief(await events("C"))).toEqual(["fill:buy:3"]);
    expect(brief(await events("E"))).toEqual(["opening:opening:15"]);
    expect((await events("A")).find((e) => e.source === "fill")!.sourceRef).toBe(`fill:${tag}1`);

    const ids = await Promise.all(["A", "B", "C", "E"].map(async (s) => (await inst(s)).id));
    expect(await db.select().from(ledgerReviewQueue).where(inArray(ledgerReviewQueue.instrumentId, ids))).toHaveLength(0);
    if (r.status === "completed")
      expect(r.counts).toMatchObject({ snapshots: 4, new_buys: 1, fills: 3, fills_new: 3, openings: 3, inferred: 0, top_ups: 1, instruments_new: 4 });

    const [p] = await db.select().from(priceLatest).where(eq(priceLatest.instrumentId, ids[0]));
    expect(p).toMatchObject({ price: "110", source: "broker" });
    const [m] = await db.select().from(marginsLatest).where(eq(marginsLatest.broker, "kite"));
    expect(Number(m.cash)).toBe((margins.equity as { available: { cash: number } }).available.cash);
    expect(vi.mocked(setStatus)).toHaveBeenCalledWith("kite", "connected", { syncedAt: expect.any(Date) });
    expect(kiteHeadlessLogin).not.toHaveBeenCalled();
  });

  it("broker LTP never clobbers a fresher stored price", async () => {
    const a = await inst("A");
    const future = new Date(Date.now() + 3_600_000);
    await db.update(priceLatest).set({ price: "999", asOf: future, source: "yahoo" }).where(eq(priceLatest.instrumentId, a.id));
    day1();
    expect((await sync()).status).toBe("completed");
    const [p] = await db.select().from(priceLatest).where(eq(priceLatest.instrumentId, a.id));
    expect(p).toMatchObject({ price: "999", source: "yahoo" });
    await db.update(priceLatest).set({ asOf: new Date(Date.now() - 3_600_000) }).where(eq(priceLatest.instrumentId, a.id));
  });

  it("re-running the same day is idempotent: own snapshot rows, no new ledger events", async () => {
    const before = await Promise.all(["A", "B", "C", "E"].map(events));
    day1();
    const r = await sync();
    expect(r.status).toBe("completed");
    expect(await snapMap(r.runId)).toEqual(await snapMap(run1));
    if (r.status === "completed") expect(r.counts).toMatchObject({ fills_new: 0, openings: 0, inferred: 0, review: 0 });
    expect((await Promise.all(["A", "B", "C", "E"].map(events))).map((e) => e.length)).toEqual(before.map((e) => e.length));
  });

  it("vanished → 0-qty row → inferred sell; a fill that explains the exit leaves no inferred event", async () => {
    kite(
      [H("C", { quantity: 0, t1_quantity: 3, average_price: 300 }), H("E", { quantity: 10, t1_quantity: 5, average_price: 50 })],
      [],
      [T("5", "B", "SELL", 5, 215)], // B's last 5 sold; A gone with no trade
    );
    const r = await sync();
    expect(r.status).toBe("completed");
    expect(await snapMap(r.runId)).toEqual({ A: [0, 0], B: [0, 0], C: [3, 3], E: [15, 5] });
    if (r.status === "completed") expect(r.counts).toMatchObject({ vanished: 2, fills_new: 1, inferred: 1 });

    expect(brief(await events("A"))).toEqual(["fill:buy:5", "inferred:sell:15", "opening:opening:10"]);
    expect(brief(await events("B"))).toEqual(["fill:sell:5", "fill:sell:5", "opening:opening:10"]); // no inferred event, not even a superseded one
    const a = await inst("A");
    const review = await db.select().from(ledgerReviewQueue).where(eq(ledgerReviewQueue.instrumentId, a.id));
    expect(review.map((i) => i.kind)).toEqual(["approximate_sell"]); // priced from the stored broker LTP
  });

  it("session expired → one headless login, then the retry succeeds", async () => {
    kite([H("F", { quantity: 2, average_price: 10 })], [], []);
    mem.expire = 1;
    const r = await sync();
    expect(r.status).toBe("completed");
    expect(kiteHeadlessLogin).toHaveBeenCalledOnce();
    expect(vi.mocked(setStatus)).toHaveBeenCalledWith("kite", "stale", expect.objectContaining({ step: "session" }));
    expect(await snapMap(r.runId)).toMatchObject({ F: [2, 0] });
  });

  it("expired again after the re-login → run failed, nothing written, no second login", async () => {
    kite([H("G", { quantity: 2, average_price: 10 })], [], []);
    mem.expire = 2;
    const r = await sync();
    expect(r.status).toBe("failed");
    expect(kiteHeadlessLogin).toHaveBeenCalledOnce();
    const [row] = await db.select().from(syncRuns).where(and(eq(syncRuns.id, r.runId)));
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/session has expired/);
    expect(await snaps(r.runId)).toHaveLength(0);
    expect(await inst("G")).toBeUndefined();
  });

  it("an empty holdings list while shares were held fails the run instead of inferring sells", async () => {
    kite([], [], []);
    const r = await sync();
    expect(r.status).toBe("failed");
    expect(await snaps(r.runId)).toHaveLength(0);
    if (r.status === "failed") expect(r.error).toMatch(/not inferring sells/);
  });
});
