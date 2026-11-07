import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db, pool } from "@/db";
import { instruments, pricesDaily } from "@/db/schema";

// Integration test against the real Neon DB. Skips when DATABASE_URL is absent (CI).
describe.skipIf(!process.env.DATABASE_URL)("market schema (Neon)", () => {
  const prefix = `TEST_${randomUUID().slice(0, 8)}_`;
  const instrument = (sym: string) => ({
    market: "IN" as const,
    exchange: "NSE",
    brokerSymbol: prefix + sym,
    name: "Test instrument",
    currency: "INR" as const,
  });

  afterAll(async () => {
    // prices_daily rows cascade.
    await db.delete(instruments).where(like(instruments.brokerSymbol, `${prefix}%`));
    await pool.end();
  });

  it("rejects a duplicate (market, broker_symbol)", async () => {
    await db.insert(instruments).values(instrument("DUP"));
    const err = await db
      .insert(instruments)
      .values(instrument("DUP"))
      .then(() => null, (e: unknown) => e);
    expect((err as { cause?: { code?: string } })?.cause?.code).toBe("23505");
  });

  it("round-trips numeric values exactly", async () => {
    const [row] = await db
      .insert(instruments)
      .values({ ...instrument("NUM"), marketCap: "0.000123" })
      .returning();
    await db
      .insert(pricesDaily)
      .values({ instrumentId: row.id, date: "2026-11-10", close: "1234.5678", volume: "0.000123" });

    const [price] = await db
      .select()
      .from(pricesDaily)
      .where(eq(pricesDaily.instrumentId, row.id));
    const [inst] = await db.select().from(instruments).where(eq(instruments.id, row.id));

    expect(price.close).toBe("1234.5678");
    expect(price.volume).toBe("0.000123");
    expect(inst.marketCap).toBe("0.000123");
  });
});
