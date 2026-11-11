import { describe, expect, it } from "vitest";
import type { Actor } from "@/lib/auth/access";
import { buildWatchlistView, type WatchInput } from "./watchlist";

const owner: Actor = { kind: "owner", email: "owner@x.com", hideAmounts: false, via: "session" };
const contributor: Actor = { kind: "contributor", email: "c@x.com", hideAmounts: false, via: "session" };
const linkViewer: Actor = { kind: "viewer", hideAmounts: true, via: "share-link" };
const NOW = new Date("2026-11-11T09:00:00Z"); // 14:30 IST

const item = (over: Partial<WatchInput> = {}): WatchInput => ({
  id: "w1",
  instrumentId: "i1",
  symbol: "TCS",
  name: "Tata Consultancy Services",
  market: "IN",
  currency: "INR",
  exchange: "NSE",
  addedAt: new Date("2026-08-13T05:00:00Z"),
  priceAtAdd: 3000,
  priceAtAddSource: "yahoo",
  note: null,
  createdBy: "owner@x.com",
  archivedAt: null,
  tags: [],
  priceUnavailable: false,
  price: { price: 3300, asOf: new Date("2026-11-11T08:00:00Z") },
  linkedBuy: null,
  ...over,
});
const build = (items: WatchInput[], actor: Actor = owner) =>
  buildWatchlistView({ items, ownerEmail: "owner@x.com", now: NOW }, actor);

describe("buildWatchlistView", () => {
  it("day change = price / previous close − 1, null without a previous close", () => {
    const [withPrev] = build([item({ price: { price: 3300, asOf: NOW, prevClose: 3000 } })]).rows;
    expect(withPrev.dayChangePct).toBeCloseTo(0.1, 10);
    expect(build([item()]).rows[0].dayChangePct).toBeNull();
  });

  it("return since added = price / price at add − 1; no annualized figure under a year", () => {
    const [r] = build([item()]).rows;
    expect(r.returnPct).toBeCloseTo(0.1, 10);
    expect(r.daysWatched).toBe(90);
    expect(r.addedOn).toBe("2026-08-13");
    expect(r.annualizedPct).toBeNull();
  });

  it("annualized only from 365 days on: 364 → null, 365 → XIRR of the two prices", () => {
    const at364 = build([item({ addedAt: new Date("2025-11-12T05:00:00Z") })]).rows[0];
    expect(at364.daysWatched).toBe(364);
    expect(at364.annualizedPct).toBeNull();

    const at730 = build([item({ addedAt: new Date("2024-11-11T05:00:00Z"), priceAtAdd: 1000, price: { price: 1210, asOf: NOW } })]).rows[0];
    expect(at730.daysWatched).toBe(730);
    expect(at730.returnPct).toBeCloseTo(0.21, 10);
    expect(at730.annualizedPct).toBeCloseTo(0.1, 6); // 1.1² = 1.21 over two years
  });

  it("linked buy: shows the buy price/date and its delta vs the watch price", () => {
    const [r] = build([item({ linkedBuy: { price: 3150, date: "2026-10-01" } })]).rows;
    expect(r.linkedBuy).toEqual({ price: 3150, date: "2026-10-01", vsWatchPct: expect.closeTo(0.05, 10) });
    expect(build([item({ priceAtAdd: null, linkedBuy: { price: 3150, date: "2026-10-01" } })]).rows[0].linkedBuy?.vsWatchPct).toBeNull();
  });

  it("missing or unavailable price → no return, no as-of", () => {
    const [a, b] = build([item({ id: "a", price: null }), item({ id: "b", symbol: "ZZ", priceUnavailable: true })]).rows;
    expect([a.returnPct, a.priceAsOf, b.price, b.returnPct]).toEqual([null, null, null, null]);
  });

  it("canEdit: owner all, contributor own only, viewer none", () => {
    const items = [item({ id: "mine", createdBy: "c@x.com" }), item({ id: "theirs", symbol: "INFY" })];
    const edit = (a: Actor) => Object.fromEntries(build(items, a).rows.map((r) => [r.id, r.canEdit]));
    expect(edit(owner)).toEqual({ mine: true, theirs: true });
    expect(edit(contributor)).toEqual({ mine: true, theirs: false });
    expect(edit(linkViewer)).toEqual({ mine: false, theirs: false });
    expect(build(items, linkViewer).canAdd).toBe(false);
    expect(build(items, contributor).canAdd).toBe(true);
  });

  it("hide-amounts share-link viewer keeps prices and % but never sees author emails", () => {
    const items = [item({ createdBy: "c@x.com", linkedBuy: { price: 3150, date: "2026-10-01" } }), item({ id: "w2", symbol: "INFY" })];
    const v = build(items, linkViewer);
    expect(v.rows.map((r) => r.createdBy).sort()).toEqual(["Contributor", "Owner"]);
    expect(v.rows.find((r) => r.symbol === "TCS")).toMatchObject({ price: 3300, priceAtAdd: 3000, returnPct: expect.any(Number) });
    expect(JSON.stringify(v)).not.toContain("@x.com");
    expect(build(items, owner).rows.map((r) => r.createdBy)).toContain("c@x.com");
  });

  it("tag counts cover active items only; archived are flagged and counted apart", () => {
    const v = build([
      item({ id: "a", tags: ["it", "defence"] }),
      item({ id: "b", symbol: "INFY", tags: ["it"] }),
      item({ id: "c", symbol: "HAL", tags: ["defence"], archivedAt: NOW }),
    ]);
    expect(v.tags).toEqual([
      { name: "defence", count: 1 },
      { name: "it", count: 2 },
    ]);
    expect(v.counts).toEqual({ active: 2, archived: 1 });
    expect(v.rows.find((r) => r.id === "c")!.archived).toBe(true);
  });

  it("US item dates are New York dates", () => {
    // 2026-08-13T02:00Z is still Aug 12 in New York.
    const [r] = build([item({ market: "US", currency: "USD", symbol: "AAPL", addedAt: new Date("2026-08-13T02:00:00Z") })]).rows;
    expect(r.addedOn).toBe("2026-08-12");
  });

  it("bucket chips per row; the add-to-bucket list only for actors who may add", () => {
    const chip = { id: "b1", name: "Manager picks", color: "chart-1" as const };
    const inputs = { items: [item({ buckets: [chip] })], buckets: [chip], ownerEmail: "owner@x.com", now: NOW };
    const mine = buildWatchlistView(inputs, contributor);
    expect(mine.rows[0].buckets).toEqual([chip]);
    expect(mine.buckets).toEqual([chip]);
    const theirs = buildWatchlistView(inputs, linkViewer);
    expect(theirs.rows[0].buckets).toEqual([chip]);
    expect(theirs.buckets).toEqual([]);
  });
});
