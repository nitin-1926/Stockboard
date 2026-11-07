import { describe, expect, it } from "vitest";
import { positionPnl } from "@/lib/returns/pnl";
import type { Actor } from "./access";
import { type FieldPolicy, POSITION_PNL_POLICY, redactForActor } from "./redact";

const hidden: Actor = { kind: "viewer", hideAmounts: true, via: "share-link" };
const full: Actor = { kind: "viewer", email: "v@example.com", hideAmounts: false, via: "session" };
const owner: Actor = { kind: "owner", email: "o@example.com", hideAmounts: false, via: "session" };

// Holdings-like DTO (the shape U13 will build).
const holding = {
  symbol: "INFY",
  price: 1520.5,
  dayChangePct: 1.2,
  pnlPct: 18.4,
  weightPct: 7.5,
  qty: 40,
  invested: 51_360,
  value: 60_820,
  pnl: 9_460,
  dayPnl: 720,
  margin: 0,
  lotSize: 1,
  cashFlows: [{ date: "2026-01-02", amountInr: -51_360 }],
};
type Holding = typeof holding;
const HOLDING_POLICY = [
  "qty",
  "invested",
  "value",
  "pnl",
  "dayPnl",
  "margin",
  "lotSize",
  "cashFlows",
] as const satisfies FieldPolicy<Holding>;

describe("redactForActor", () => {
  it("hide-amounts: amount fields are absent (not zeroed); prices and percentages stay", () => {
    const r = redactForActor(hidden, holding, HOLDING_POLICY);
    for (const k of HOLDING_POLICY) expect(r).not.toHaveProperty(k);
    expect(r).toEqual({ symbol: "INFY", price: 1520.5, dayChangePct: 1.2, pnlPct: 18.4, weightPct: 7.5 });
    // Serialized payload carries no trace of the amounts either.
    const json = JSON.stringify(r);
    for (const k of ["qty", "invested", "value", "60820", "51360"]) expect(json).not.toContain(k);
  });

  it("does not mutate the input DTO", () => {
    redactForActor(hidden, holding, HOLDING_POLICY);
    expect(holding.qty).toBe(40);
  });

  it("non-hide actors (viewer without flag, owner) get everything", () => {
    expect(redactForActor(full, holding, HOLDING_POLICY)).toEqual(holding);
    expect(redactForActor(owner, holding, HOLDING_POLICY)).toEqual(holding);
  });

  it("POSITION_PNL_POLICY strips every amount from a real positionPnl result", () => {
    const pnl = positionPnl({
      lots: [
        {
          instrumentId: "i1",
          market: "IN",
          currency: "INR",
          qty: 10,
          costPerShare: 100,
          openDate: "2026-01-02",
          fxRateAtOpen: 1,
          closed: [],
        },
      ],
      price: 120,
      fxNow: 1,
      asOf: "2026-11-11",
    });
    expect(redactForActor(hidden, pnl, POSITION_PNL_POLICY)).toEqual({});
    expect(redactForActor(full, pnl, POSITION_PNL_POLICY)).toEqual(pnl);
  });
});
