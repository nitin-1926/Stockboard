import { describe, expect, it } from "vitest";
import { toYahooSymbol, yahooSymbolFor, yahooUrlSymbol } from "./symbols";

const nse = (brokerSymbol: string) => ({ market: "IN" as const, exchange: "NSE", brokerSymbol });
const url = (i: Parameters<typeof toYahooSymbol>[0]) => yahooUrlSymbol(toYahooSymbol(i));

describe("toYahooSymbol", () => {
  it("encodes & only at URL time: M&M → M%26M.NS", () => {
    expect(toYahooSymbol(nse("M&M"))).toBe("M&M.NS");
    expect(url(nse("M&M"))).toBe("M%26M.NS");
  });
  it("keeps real hyphens: BAJAJ-AUTO → BAJAJ-AUTO.NS", () => {
    expect(url(nse("BAJAJ-AUTO"))).toBe("BAJAJ-AUTO.NS");
  });
  it("US dots become dashes: BRK.B → BRK-B", () => {
    expect(url({ market: "US", exchange: "NYSE", brokerSymbol: "BRK.B" })).toBe("BRK-B");
  });
  it("NIFTYBEES → NIFTYBEES.NS", () => {
    expect(url(nse("NIFTYBEES"))).toBe("NIFTYBEES.NS");
  });
  it("override table wins: TATAMOTORS → TMPV.NS", () => {
    expect(url(nse("TATAMOTORS"))).toBe("TMPV.NS");
  });
  it("strips series suffix: XYZ-BE → XYZ.NS", () => {
    expect(url(nse("XYZ-BE"))).toBe("XYZ.NS");
    expect(url(nse("ABC-SM"))).toBe("ABC.NS");
  });
  it("BSE → .BO", () => {
    expect(url({ market: "IN", exchange: "BSE", brokerSymbol: "RELIANCE" })).toBe("RELIANCE.BO");
  });
  it("indices and FX pairs untouched", () => {
    expect(toYahooSymbol(nse("^NSEI"))).toBe("^NSEI");
    expect(toYahooSymbol({ market: "US", exchange: "CCY", brokerSymbol: "USDINR=X" })).toBe("USDINR=X");
  });
  it("DB override beats stored and computed symbol", () => {
    expect(yahooSymbolFor({ ...nse("FOO"), yahooSymbol: "FOO.NS", yahooSymbolOverride: "BAR.NS" })).toBe("BAR.NS");
    expect(yahooSymbolFor({ ...nse("FOO"), yahooSymbol: null })).toBe("FOO.NS");
  });
});
