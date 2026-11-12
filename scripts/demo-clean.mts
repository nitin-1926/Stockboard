// pnpm demo:clean: removes every demo row written by demo-seed.mts and verifies none remain.
// Instruments cascade to snapshots, ledger events (+ supersessions, review items),
// price_latest and prices_daily; the demo sync run and demo-sourced FX go separately.
import { pool } from "@/db";

export async function cleanDemo() {
  await pool.query(String.raw`DELETE FROM instruments WHERE broker_symbol LIKE 'DEMO\_%'`);
  await pool.query(`DELETE FROM sync_runs WHERE job = 'demo'`);
  await pool.query(`DELETE FROM fx_daily WHERE source = 'demo'`);
  const { rows } = await pool.query(String.raw`SELECT
    (SELECT count(*) FROM instruments WHERE broker_symbol LIKE 'DEMO\_%')::int AS instruments,
    (SELECT count(*) FROM sync_runs WHERE job = 'demo')::int AS runs,
    (SELECT count(*) FROM fx_daily WHERE source = 'demo')::int AS fx,
    (SELECT count(*) FROM ledger_events WHERE source_ref LIKE 'demo:%')::int AS events`);
  return rows[0] as Record<string, number>;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const left = await cleanDemo();
  const total = Object.values(left).reduce((a, b) => a + b, 0);
  console.log(`demo rows left: ${JSON.stringify(left)}`);
  await pool.end();
  if (total) process.exit(1);
}
