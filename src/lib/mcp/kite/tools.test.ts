import { describe, expect, it, vi } from "vitest";
import allTrades from "../__fixtures__/kite-orders-all_trades.json";
import holdings from "../__fixtures__/kite-portfolio-holdings.json";
import page1 from "../__fixtures__/kite-portfolio-holdings-page1.json";
import page2 from "../__fixtures__/kite-portfolio-holdings-page2.json";
import margins from "../__fixtures__/kite-portfolio-margins.json";
import positions from "../__fixtures__/kite-portfolio-positions.json";
import profile from "../__fixtures__/kite-portfolio-profile.json";
import ltp from "../__fixtures__/kite-market-ltp.json";
import type { ToolCaller } from "../client";
import { getHoldings, getLtp, getMargins, getPositions, getProfile, getTodayTrades, kiteCall } from "./tools";

const sc = (f: { structuredContent?: unknown }) => structuredClone(f.structuredContent) as Record<string, unknown>;
const caller = (byMode: Record<string, unknown>) =>
  vi.fn<ToolCaller>(async (tool, args) => {
    const r = byMode[`${tool}:${args.mode}`];
    if (r === undefined) throw new Error(`unexpected ${tool}:${args.mode}`);
    return r;
  });

describe("Kite tools", () => {
  it("holdings fixture → normalized BrokerHolding, one page at limit 500", async () => {
    const call = caller({ "portfolio:holdings": sc(holdings) });
    const rows = await getHoldings(call);
    expect(rows).toHaveLength(32);
    expect(rows[0]).toEqual({
      brokerSymbol: "BBBB",
      exchange: "NSE",
      isin: "KIB203K59333",
      qty: 50,
      openingQty: 50,
      usedQty: 0,
      t1Qty: 0,
      avgPrice: 1028.86,
      lastPrice: 334.62,
      closePrice: 1807.66,
    });
    for (const h of rows) expect(h.qty).toBe(h.openingQty - h.usedQty);
    expect(call).toHaveBeenCalledWith("portfolio", { type: "full", from: 0, limit: 500, mode: "holdings" });
  });

  it("paginates on has_more across 2 pages", async () => {
    const p2 = sc(page2);
    p2.pagination = { ...(p2.pagination as object), has_more: false };
    const call = vi.fn<ToolCaller>(async (_t, args) => (args.from === 0 ? sc(page1) : p2));
    const rows = await getHoldings(call);
    expect(rows.map((r) => r.brokerSymbol)).toEqual([
      ...(sc(page1).data as { tradingsymbol: string }[]).map((r) => r.tradingsymbol),
      ...(p2.data as { tradingsymbol: string }[]).map((r) => r.tradingsymbol),
    ]);
    expect(call.mock.calls.map(([, a]) => a.from)).toEqual([0, 2]);
  });

  it("empty holdings → empty array", async () => {
    const empty = { data: [], pagination: { from: 0, limit: 500, total: 0, has_more: false, returned: 0 } };
    expect(await getHoldings(caller({ "portfolio:holdings": empty }))).toEqual([]);
  });

  it("positions keep day and net views apart", async () => {
    const rows = await getPositions(caller({ "portfolio:positions": sc(positions) }));
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({ view: "day", brokerSymbol: "EEEE", product: "CNC", qty: -140, sellQty: 140, sellAvg: 683.3 });
    expect(new Set(rows.map((r) => r.view))).toEqual(new Set(["day", "net"]));
  });

  it("all_trades → BrokerTrade with +05:30 executedAt", async () => {
    const rows = await getTodayTrades(caller({ "orders:all_trades": sc(allTrades) }));
    expect(rows).toHaveLength(11);
    expect(rows[0]).toEqual({
      tradeId: "188842807",
      orderId: "882849182040192",
      exchange: "NSE",
      symbol: "CCCC",
      product: "CNC",
      side: "SELL",
      qty: 52,
      price: 1095.66,
      executedAt: "2026-11-12T13:51:59+05:30",
    });
  });

  it("a fill timestamp without an offset fails loudly", async () => {
    const t = sc(allTrades);
    (t.data as Record<string, unknown>[])[0].fill_timestamp = "2026-11-12 13:51:59";
    await expect(getTodayTrades(caller({ "orders:all_trades": t }))).rejects.toThrow(/orders:all_trades: schema drift/);
  });

  it("margins, profile and ltp parse", async () => {
    const call = caller({
      "portfolio:margins": sc(margins),
      "portfolio:profile": sc(profile),
      "market:ltp": sc(ltp),
    });
    expect((await getMargins(call)).equity).toEqual({
      enabled: true,
      net: 174.2,
      cash: 664.13,
      collateral: 0,
      liveBalance: 2563.4,
      openingBalance: 2767.25,
      utilised: -980.99,
    });
    expect(await getProfile(call)).toEqual({ userId: "SCZ481", broker: "ZERODHA" });
    expect(await getLtp(call, ["NSE:AAAA", "NSE:BBBB"])).toEqual({ "NSE:AAAA": 2024.15, "NSE:BBBB": 2078.3 });
    expect(await getLtp(call, [])).toEqual({});
  });

  it("allowlist rejects writes and session logout without any call", () => {
    const call = vi.fn<ToolCaller>();
    for (const [tool, mode] of [
      ["orders", "place"],
      ["orders", "modify"],
      ["orders", "cancel"],
      ["session", "logout"],
      ["gtt", "place"],
      ["alerts", "create"],
      ["constructor", "list"],
    ]) {
      expect(() => kiteCall(call, tool, mode)).toThrow(`Kite ${tool}:${mode} is not on the read-only allowlist`);
    }
    expect(call).not.toHaveBeenCalled();
  });

  it("args cannot override the allowlisted mode", async () => {
    const call = vi.fn<ToolCaller>(async () => ({}));
    await kiteCall(call, "portfolio", "profile", { mode: "place" });
    expect(call).toHaveBeenCalledWith("portfolio", { mode: "profile" });
  });

  it("schema drift (renamed field) → loud error naming tool and mode", async () => {
    const h = sc(holdings);
    const row = (h.data as Record<string, unknown>[])[0];
    row.qty = row.quantity;
    delete row.quantity;
    await expect(getHoldings(caller({ "portfolio:holdings": h }))).rejects.toThrow(
      /^portfolio:holdings: schema drift: [\s\S]*quantity/,
    );
  });
});
