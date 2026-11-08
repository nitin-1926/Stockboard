// pnpm db:seed — idempotent reference data. Env comes from --env-file-if-exists=.env.local.
import { pool } from "@/db";
import { seedBenchmarks } from "@/lib/market/seed";

const rows = await seedBenchmarks();
console.log(`seeded benchmarks: ${rows.map((r) => r.brokerSymbol).join(", ")}`);
await pool.end();
