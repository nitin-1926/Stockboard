import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSeries, forwardFill, rateOn } from "./fx";
import { retry } from "./yahoo";

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  retry.baseMs = 0;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("fx", () => {
  it("a Saturday date → the Friday rate", async () => {
    fetchMock.mockResolvedValue(new Response(fixture("frankfurter-2026-11-07.json")));
    expect(await rateOn("2026-11-07")).toEqual({ date: "2026-11-06", rate: 93.92 });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.frankfurter.dev/v1/2026-11-07?base=USD&symbols=INR");
  });

  it("time-series gaps (weekend) are forward-filled", async () => {
    fetchMock.mockResolvedValue(new Response(fixture("frankfurter-series.json")));
    const { map, source } = await fetchSeries("2026-10-30", "2026-11-05");
    expect(source).toBe("frankfurter");
    expect(fetchMock.mock.calls[0][0]).toContain("/v1/2026-10-30..2026-11-05?");
    const filled = forwardFill(map, "2026-10-31", "2026-11-03");
    expect(filled).toEqual([
      { date: "2026-10-31", rate: 94.95, filled: true }, // Sat ← Fri
      { date: "2026-11-01", rate: 94.95, filled: true }, // Sun ← Fri
      { date: "2026-11-02", rate: 94.91, filled: false },
      { date: "2026-11-03", rate: 94.75, filled: false },
    ]);
  });

  it("skips dates before the first known rate", () => {
    expect(forwardFill(new Map([["2026-11-02", 94.91]]), "2026-11-01", "2026-11-02")).toEqual([
      { date: "2026-11-02", rate: 94.91, filled: false },
    ]);
  });

  it("falls back to Yahoo USDINR=X when Frankfurter fails", async () => {
    const chartBody = JSON.parse(readFileSync(new URL("./__fixtures__/chart-split-10-1.json", import.meta.url), "utf8"));
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("frankfurter") ? new Response("down", { status: 503 }) : new Response(JSON.stringify(chartBody)),
    );
    const { map, source } = await fetchSeries("2026-03-02", "2026-03-05");
    expect(source).toBe("yahoo");
    expect(fetchMock.mock.calls[1][0]).toContain("/v8/finance/chart/USDINR%3DX?");
    expect(map.get("2026-03-05")).toBe(101.5);
  });
});
