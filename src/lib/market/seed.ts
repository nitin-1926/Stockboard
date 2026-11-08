import { sql } from "drizzle-orm";
import { db } from "@/db";
import { instruments } from "@/db/schema";

// Benchmarks for PME (docs/plans U12): NIFTYBEES for IN, SPY for US. Idempotent.
export const BENCHMARKS = [
  {
    market: "IN" as const,
    exchange: "NSE",
    brokerSymbol: "NIFTYBEES",
    yahooSymbol: "NIFTYBEES.NS",
    name: "Nippon India ETF Nifty 50 BeES",
    assetClass: "etf" as const,
    currency: "INR" as const,
    isBenchmark: true,
  },
  {
    market: "US" as const,
    exchange: "NYSEARCA",
    brokerSymbol: "SPY",
    yahooSymbol: "SPY",
    name: "SPDR S&P 500 ETF Trust",
    assetClass: "etf" as const,
    currency: "USD" as const,
    isBenchmark: true,
  },
];

export async function seedBenchmarks() {
  return db
    .insert(instruments)
    .values(BENCHMARKS)
    .onConflictDoUpdate({
      target: [instruments.market, instruments.brokerSymbol],
      set: { isBenchmark: true, yahooSymbol: sql`excluded.yahoo_symbol` },
    })
    .returning({ id: instruments.id, brokerSymbol: instruments.brokerSymbol });
}
