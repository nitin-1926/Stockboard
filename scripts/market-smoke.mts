// Opt-in live check of Yahoo + Frankfurter (hits the network, no DB). Run: pnpm market:smoke
import { rateOn } from "@/lib/market/fx";
import { chart } from "@/lib/market/yahoo";

for (const sym of ["RELIANCE.NS", "AAPL", "^NSEI", "USDINR=X"]) {
  try {
    const c = await chart(sym, { range: "1mo" });
    const last = c.bars.at(-1);
    console.log(
      `${sym}: ${c.currency} price=${c.price} bars=${c.bars.length} last=${last?.date}@${last?.close.toFixed(2)} splits=${c.splits.length} divs=${c.dividends.length}`,
    );
  } catch (e) {
    console.log(`${sym}: FAILED ${(e as Error).name}: ${(e as Error).message}`);
  }
}
try {
  const fx = await rateOn("latest");
  console.log(`frankfurter latest: USDINR=${fx.rate} on ${fx.date}`);
} catch (e) {
  console.log(`frankfurter latest: FAILED ${(e as Error).message}`);
}
