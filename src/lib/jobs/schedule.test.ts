import { describe, expect, it } from "vitest";
import { isMarketOpen, isStale } from "./schedule";

const at = (iso: string) => new Date(iso);

describe("isMarketOpen", () => {
  it("NY follows DST", () => {
    expect(isMarketOpen("US", at("2026-11-11T14:45:00Z"))).toBe(true); // 09:45 EST
    expect(isMarketOpen("US", at("2026-11-11T13:45:00Z"))).toBe(false); // 08:45 EST
    expect(isMarketOpen("US", at("2026-07-15T13:45:00Z"))).toBe(true); // 09:45 EDT
    expect(isMarketOpen("US", at("2026-07-15T20:15:00Z"))).toBe(false); // 16:15 EDT
    expect(isMarketOpen("US", at("2026-11-11T20:45:00Z"))).toBe(true); // 15:45 EST
  });

  it("IST session 09:15–15:30", () => {
    expect(isMarketOpen("IN", at("2026-11-11T03:40:00Z"))).toBe(false); // 09:10
    expect(isMarketOpen("IN", at("2026-11-11T03:45:00Z"))).toBe(true); // 09:15
    expect(isMarketOpen("IN", at("2026-11-11T10:00:00Z"))).toBe(true); // 15:30
    expect(isMarketOpen("IN", at("2026-11-11T10:15:00Z"))).toBe(false); // 15:45
    expect(isMarketOpen("IN", at("2026-07-15T05:00:00Z"))).toBe(true); // no DST in IST
  });

  it("closed on weekends", () => {
    expect(isMarketOpen("IN", at("2026-11-14T05:00:00Z"))).toBe(false); // Sat
    expect(isMarketOpen("US", at("2026-11-15T15:00:00Z"))).toBe(false); // Sun
  });
});

describe("isStale", () => {
  const fridaySuccess = at("2026-11-13T02:35:00Z");

  it("Friday success stays fresh over the weekend", () => {
    expect(isStale("kite-login", fridaySuccess, at("2026-11-16T01:00:00Z"))).toBe(false); // Mon
    expect(isStale("kite-login", fridaySuccess, at("2026-11-16T03:30:00Z"))).toBe(false); // in grace
  });

  it("stale once a missed slot's grace has elapsed", () => {
    expect(isStale("kite-login", fridaySuccess, at("2026-11-16T04:01:00Z"))).toBe(true);
    expect(isStale("kite-login", fridaySuccess, at("2026-11-17T06:00:00Z"))).toBe(true); // Tue
  });

  it("missed earlier day is not masked by today's slot still in grace", () => {
    expect(isStale("kite-login", fridaySuccess, at("2026-11-17T02:40:00Z"))).toBe(true);
  });

  it("never-run job is stale; manual job never is", () => {
    expect(isStale("eod-in", null, at("2026-11-11T13:00:00Z"))).toBe(true);
    expect(isStale("backfill", null, at("2026-11-11T13:00:00Z"))).toBe(false);
  });

  it("kite-sync self-heal run is within grace", () => {
    const now = at("2026-11-11T12:00:00Z");
    expect(isStale("kite-sync", at("2026-11-10T10:20:00Z"), now)).toBe(false);
    expect(isStale("kite-sync", at("2026-11-11T11:35:00Z"), at("2026-11-11T13:00:00Z"))).toBe(false);
    expect(isStale("kite-sync", at("2026-11-10T10:20:00Z"), at("2026-11-11T12:46:00Z"))).toBe(true);
  });
});
