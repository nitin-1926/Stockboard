import { describe, expect, it } from "vitest";
import type { Actor } from "@/lib/auth/access";
import { buildMarginsView } from "./margins";

const owner: Actor = { kind: "owner", hideAmounts: false, via: "session" };
const hidden: Actor = { kind: "viewer", hideAmounts: true, via: "share-link" };
const row = { broker: "kite" as const, cash: "664.13", used: "-980.99", net: "174.2", asOf: new Date("2026-11-12T10:15:00Z") };

describe("buildMarginsView", () => {
  it("owner gets the amounts", () => {
    expect(buildMarginsView(row, owner)).toEqual({ cash: 664.13, used: -980.99, net: 174.2, asOf: "2026-11-12T10:15:00.000Z" });
  });

  it("hide-amounts viewer gets only the as-of time (no amount in the payload)", () => {
    const v = buildMarginsView(row, hidden);
    expect(v).toEqual({ asOf: "2026-11-12T10:15:00.000Z" });
    expect(JSON.stringify(v)).not.toMatch(/664|980|174/);
  });

  it("null before the first sync", () => {
    expect(buildMarginsView(null, owner)).toBeNull();
  });
});
