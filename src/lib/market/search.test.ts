import { describe, expect, it } from "vitest";
import { exactMatch, parseSearch } from "./search";

// Trimmed from a live /v1/finance/search?q=infosys response (2026-11-11).
const body = {
  quotes: [
    { symbol: "INFY", longname: "Infosys Limited", exchange: "NYQ", quoteType: "EQUITY" },
    { symbol: "INFY.NS", longname: "Infosys Limited", exchange: "NSI", quoteType: "EQUITY" },
    { symbol: "INFY.BO", shortname: "INFOSYS LTD.", exchange: "BSE", quoteType: "EQUITY" },
    { symbol: "SMALLCO.BO", shortname: "SMALL CO", exchange: "BSE", quoteType: "EQUITY" },
    { symbol: "IOY.MU", longname: "Infosys Ltd", exchange: "MUN", quoteType: "EQUITY" },
    { symbol: "TCSEX", longname: "Nuveen fund", exchange: "NAS", quoteType: "MUTUALFUND" },
    { symbol: "VOO", longname: "Vanguard S&P 500 ETF", exchange: "PCX", quoteType: "ETF" },
    { symbol: "BRKB261113C00532500", exchange: "OPR", quoteType: "OPTION" },
  ],
};

describe("parseSearch", () => {
  const hits = parseSearch(body);

  it("keeps equities/ETFs on NSE/BSE/US exchanges and drops a BSE line that is also on NSE", () => {
    expect(hits.map((h) => h.symbol)).toEqual(["INFY", "INFY.NS", "SMALLCO.BO", "VOO"]);
    expect(hits.find((h) => h.symbol === "INFY.NS")).toEqual({
      symbol: "INFY.NS",
      name: "Infosys Limited",
      exchange: "NSE",
      market: "IN",
      currency: "INR",
      type: "equity",
    });
    expect(hits.find((h) => h.symbol === "VOO")).toMatchObject({ exchange: "NYSE Arca", market: "US", currency: "USD", type: "etf" });
  });

  it("exactMatch: ticker only, India first without a hint, the hint wins otherwise", () => {
    expect(exactMatch("infy", hits)?.symbol).toBe("INFY.NS");
    expect(exactMatch("INFY", hits, "US")?.symbol).toBe("INFY");
    expect(exactMatch("Infosys", hits)).toBeNull();
    expect(exactMatch("SMALLCO", hits)?.exchange).toBe("BSE");
    expect(exactMatch("VOO", hits, "IN")).toBeNull();
    expect(parseSearch({})).toEqual([]);
  });
});
