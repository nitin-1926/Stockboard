import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chart, crumbStore, parseChart, quoteSummary, retry, spark, toRaw, YahooNotFound, YahooRateLimited } from "./yahoo";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"));
const res = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  retry.baseMs = 0;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseChart", () => {
  it("parses closes, adjcloses, dividends and splits with dates from `date` (not the key)", () => {
    const c = parseChart(fixture("chart-split-10-1.json"), "TEST.NS");
    expect(c.bars.map((b) => b.date)).toEqual(["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"]);
    expect(c.bars.map((b) => b.close)).toEqual([100, 101, 99, 101.5]);
    expect(c.bars.map((b) => b.adjClose)).toEqual([99.5, 100.5, 99, 101.5]);
    expect(c.splits).toEqual([{ date: "2026-03-04", numerator: 10, denominator: 1 }]);
    expect(c.dividends).toEqual([{ date: "2026-03-02", amount: 0.5 }]);
    expect(c.prevClose).toBe(99); // priced 2026-03-05 → the 03-04 close
    expect(c.currency).toBe("INR");
    expect(c.price).toBe(101.5);
  });

  it("parses a recorded real chart (AAPL 4:1 split, 2020-08-31)", () => {
    const c = parseChart(fixture("chart-aapl-2020-split.json"), "AAPL");
    expect(c.splits).toEqual([{ date: "2020-08-31", numerator: 4, denominator: 1 }]);
    expect(c.bars).toHaveLength(9);
    // Yahoo close is split-adjusted: 28 Aug 2020 traded ~499 but comes back ~124.8.
    const raw = toRaw(c, c.splits).bars.find((b) => b.date === "2020-08-28")!;
    expect(raw.close).toBeCloseTo(499.23, 2);
  });
});

describe("toRaw", () => {
  it("10:1 split: bars before the ex-date ×10, ex-date and after unchanged; volume ÷10; dividend ×10", () => {
    const c = parseChart(fixture("chart-split-10-1.json"), "TEST.NS");
    const raw = toRaw(c, c.splits);
    expect(raw.bars.map((b) => b.close)).toEqual([1000, 1010, 99, 101.5]);
    expect(raw.bars[0].open).toBe(990);
    expect(raw.bars.map((b) => b.volume)).toEqual([1000, 2000, 300000, 400000]);
    expect(raw.bars[0].adjClose).toBe(99.5); // informational, untouched
    expect(raw.dividends).toEqual([{ date: "2026-03-02", amount: 5 }]);
  });
});

describe("chart/spark HTTP", () => {
  it("sends a browser User-Agent and URL-encodes the symbol", async () => {
    fetchMock.mockResolvedValue(res(fixture("chart-split-10-1.json")));
    await chart("M&M.NS", { range: "max" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/v8/finance/chart/M%26M.NS?");
    expect(url).toContain("events=div%2Csplits");
    expect(url).toContain("period1=0&"); // range=max would return monthly bars
    expect(url).not.toContain("range=");
    expect(init.headers["User-Agent"]).toBe("Mozilla/5.0");
  });

  it("404 / No data found → YahooNotFound", async () => {
    fetchMock.mockResolvedValue(res(fixture("chart-404.json"), 404));
    await expect(chart("TATAMOTORS.NS")).rejects.toBeInstanceOf(YahooNotFound);
  });

  it("429 → retries 3 times then YahooRateLimited", async () => {
    fetchMock.mockResolvedValue(res("Too Many Requests", 429));
    await expect(chart("AAPL")).rejects.toBeInstanceOf(YahooRateLimited);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("429 then 200 → succeeds on retry", async () => {
    fetchMock.mockResolvedValueOnce(res("", 429)).mockResolvedValueOnce(res(fixture("chart-split-10-1.json")));
    await expect(chart("AAPL")).resolves.toMatchObject({ price: 101.5 });
  });

  it("spark parses the batch and chunks at 20 symbols", async () => {
    fetchMock.mockImplementation(async () => res(fixture("spark.json")));
    const syms = Array.from({ length: 41 }, (_, i) => `S${i}`);
    const out = await spark(["AAPL", "M&M.NS", ...syms]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toContain("symbols=AAPL,M%26M.NS,S0");
    expect(out.get("AAPL")?.price).toBe(353.61);
    expect(out.get("M&M.NS")?.price).toBe(3465);
    // Previous session's close from the bars (meta chartPreviousClose is the pre-RANGE close).
    expect(out.get("AAPL")?.prevClose).toBe(348.51);
    expect(out.get("M&M.NS")?.prevClose).toBe(3290.6);
  });

  it("spark: all-unknown chunk (404) yields an empty map, not an error", async () => {
    fetchMock.mockResolvedValue(res({ spark: { result: null, error: { code: "Not Found", description: "No data found for spark symbols" } } }, 404));
    expect((await spark(["ZZZ.NS"])).size).toBe(0);
  });
});

describe("quoteSummary crumb flow", () => {
  const summary = {
    quoteSummary: {
      result: [{ assetProfile: { sector: "Energy", industry: "Oil & Gas" }, price: { marketCap: { raw: 123 }, longName: "Reliance", currency: "INR" } }],
      error: null,
    },
  };

  it("401 with cached crumb → refetches cookie+crumb once, saves it, retries", async () => {
    vi.spyOn(crumbStore, "load").mockResolvedValue({ crumb: "stale", cookie: "A3=old" });
    const save = vi.spyOn(crumbStore, "save").mockResolvedValue();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const cookie = (init?.headers as Record<string, string>)?.Cookie;
      if (url === "https://fc.yahoo.com") return res("", 404, { "set-cookie": "A3=fresh; Domain=.yahoo.com; Path=/" });
      if (url.includes("/v1/test/getcrumb")) return cookie === "A3=fresh" ? res("newcrumb") : res("", 403);
      if (url.includes("crumb=stale")) return res({ finance: { result: null, error: { code: "Unauthorized", description: "Invalid Crumb" } } }, 401);
      if (url.includes("crumb=newcrumb") && cookie === "A3=fresh") return res(summary);
      throw new Error(`unexpected ${url}`);
    });
    const s = await quoteSummary("RELIANCE.NS");
    expect(s).toEqual({ sector: "Energy", industry: "Oil & Gas", marketCap: 123, name: "Reliance", currency: "INR" });
    expect(save).toHaveBeenCalledWith({ crumb: "newcrumb", cookie: "A3=fresh" });
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("getcrumb"))).toHaveLength(1);
  });

  it("uses the cached crumb without touching fc.yahoo.com", async () => {
    vi.spyOn(crumbStore, "load").mockResolvedValue({ crumb: "good", cookie: "A3=ok" });
    fetchMock.mockResolvedValue(res(summary));
    await quoteSummary("RELIANCE.NS");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
