import { describe, expect, it } from "vitest";
import { isLongTerm, ltcgEligibleDate } from "./tax";

describe("ltcgEligibleDate", () => {
  it("IN lot bought 2025-11-12 → long-term from 2026-11-13 (> 12 months)", () => {
    expect(ltcgEligibleDate("2025-11-12", "IN")).toBe("2026-11-13");
  });

  it("US lot bought 2025-11-12 → long-term from 2027-11-13 (> 24 months)", () => {
    expect(ltcgEligibleDate("2025-11-12", "US")).toBe("2027-11-13");
  });

  it("bonus lot uses its own allotment date, not the parent lot's", () => {
    // Parent bought 2024-01-10; bonus allotted 2026-03-01 is a separate zero-cost lot.
    expect(ltcgEligibleDate("2024-01-10", "IN")).toBe("2025-01-11");
    expect(ltcgEligibleDate("2026-03-01", "IN")).toBe("2027-03-02");
  });

  it("leap day: 2024-02-29 + 12 months clamps to Feb 28, eligible Mar 1", () => {
    expect(ltcgEligibleDate("2024-02-29", "IN")).toBe("2025-03-01");
  });

  it("month-end and year rollover", () => {
    expect(ltcgEligibleDate("2025-12-31", "IN")).toBe("2027-01-01");
  });
});

describe("isLongTerm", () => {
  it("flips exactly on the eligibility date", () => {
    expect(isLongTerm("2025-11-12", "IN", "2026-11-12")).toBe(false);
    expect(isLongTerm("2025-11-12", "IN", "2026-11-13")).toBe(true);
    expect(isLongTerm("2025-11-12", "US", "2027-11-12")).toBe(false);
    expect(isLongTerm("2025-11-12", "US", "2027-11-13")).toBe(true);
  });
});
