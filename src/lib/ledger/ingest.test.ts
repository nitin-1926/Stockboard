import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, between, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, pool } from "@/db";
import {
  corporateActions,
  fxDaily,
  holdingSnapshots,
  instruments,
  ledgerEvents,
  ledgerReviewQueue,
  ledgerSupersessions,
  syncRuns,
} from "@/db/schema";
import type { Actor } from "@/lib/auth/access";
import { retry } from "@/lib/market/yahoo";
import { importConsoleCsv, importUsHistory, ingestFills, ingestSnapshotRun, REF_COPIERS } from "./ingest";
import { eventId, getLedgerState } from "./queries";

const fixture = readFileSync(new URL("./__fixtures__/console-tradebook.csv", import.meta.url), "utf8");
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

// Frankfurter business-day series (weekends absent, as the real API returns).
const FX: Record<string, number> = {
  "2002-03-01": 48.81,
  "2002-03-04": 48.82,
  "2002-03-05": 48.83,
  "2002-03-06": 48.84,
  "2002-03-07": 48.85,
  "2002-03-08": 48.86,
  "2002-03-11": 48.9,
  "2002-03-12": 48.91,
  "2002-03-13": 48.92,
  "2002-03-14": 48.93,
  "2002-03-15": 48.94,
};

// Integration: real Neon DB, mocked network (Yahoo + Frankfurter). Skips without DATABASE_URL (CI).
// Each ingest is ~15 round trips; at ~250 ms each from a laptop a test needs well over 5 s.
describe.skipIf(!process.env.DATABASE_URL)("ledger ingest (Neon, mocked network)", { timeout: 120_000 }, () => {
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const prefix = `TEST_${tag}_`;
  const job = `test-ledger-${tag}`;
  const owner: Actor = { kind: "owner", hideAmounts: false, via: "session" };
  const splits: Record<string, { exDate: string; num: number; den: number }[]> = {};
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("frankfurter"))
      return json({ rates: Object.fromEntries(Object.entries(FX).map(([d, r]) => [d, { INR: r }])) });
    if (url.includes("/v8/finance/chart/")) {
      const sym = decodeURIComponent(url.split("/chart/")[1].split("?")[0]);
      const ev = (splits[sym] ?? []).map((s) => [
        s.exDate,
        { date: Date.parse(`${s.exDate}T15:00:00Z`) / 1000, numerator: s.num, denominator: s.den },
      ]);
      return json({
        chart: {
          result: [
            {
              meta: { symbol: sym, gmtoffset: 19800, currency: "INR" },
              timestamp: [],
              indicators: { quote: [{}], adjclose: [{ adjclose: [] }] },
              events: { splits: Object.fromEntries(ev) },
            },
          ],
        },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  const fetched = (part: string) => fetchMock.mock.calls.some(([u]) => String(u).includes(part));

  const mk = async (sym: string, market: "IN" | "US" = "IN") => {
    const [row] = await db
      .insert(instruments)
      .values({
        market,
        exchange: market === "IN" ? "NSE" : "US",
        brokerSymbol: prefix + sym,
        name: sym,
        currency: market === "IN" ? "INR" : "USD",
      })
      .returning();
    return row;
  };
  const run = async (broker: "kite" | "indmoney", takenAt: string, rows: [{ id: string }, number, number][]) => {
    const [r] = await db.insert(syncRuns).values({ job, broker, status: "completed" }).returning();
    await db.insert(holdingSnapshots).values(
      rows.map(([i, qty, avg]) => ({
        runId: r.id,
        broker,
        instrumentId: i.id,
        takenAt: new Date(takenAt),
        qty: String(qty),
        avgPrice: String(avg),
      })),
    );
    return r.id;
  };
  const events = (id: string) => db.select().from(ledgerEvents).where(eq(ledgerEvents.instrumentId, id));
  const qtyOf = async (id: string) => (await getLedgerState([id])).positions[id]?.qty ?? 0;
  const review = (id: string) => db.select().from(ledgerReviewQueue).where(eq(ledgerReviewQueue.instrumentId, id));

  beforeEach(() => {
    retry.baseMs = 0;
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    // Cascades to ledger events (→ supersessions), snapshots, review items, corporate actions.
    await db.delete(instruments).where(like(instruments.brokerSymbol, `${prefix}%`));
    await db.delete(syncRuns).where(eq(syncRuns.job, job));
    await db.delete(fxDaily).where(between(fxDaily.date, "2002-02-20", "2002-03-31"));
    await pool.end();
  });

  it("first snapshot bootstraps an opening; an inferred buy is idempotent across re-runs", async () => {
    const a = await mk("IDEM");
    const r1 = await run("kite", "2026-11-02T10:15:00Z", [[a, 10, 100]]);
    await ingestSnapshotRun(r1);
    await ingestSnapshotRun(r1);
    const r2 = await run("kite", "2026-11-03T10:15:00Z", [[a, 15, 110]]);
    expect((await ingestSnapshotRun(r2)).inserted).toBe(1);
    expect((await ingestSnapshotRun(r2)).inserted).toBe(0);
    await ingestSnapshotRun(r1);

    const rows = await events(a.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((e) => e.type === "opening")).toMatchObject({
      source: "opening",
      sourceRef: `opening:kite:${a.id}`,
      date: "2026-11-02",
      approximate: true,
      price: "100",
      fxRateInr: "1",
      broker: "kite",
    });
    expect(rows.find((e) => e.type === "buy")).toMatchObject({
      source: "inferred",
      sourceRef: `inferred:${a.id}:${r1}:${r2}`,
      qty: "5",
      price: "130", // (15×110 − 10×100) / 5
      approximate: true,
    });
    expect(await qtyOf(a.id)).toBe(15);
  });

  it("a fill arriving after the inference supersedes it; replayed qty equals the snapshot", async () => {
    const b = await mk("FILL");
    await ingestSnapshotRun(await run("kite", "2026-11-02T10:15:00Z", [[b, 10, 100]]));
    const r2 = await run("kite", "2026-11-03T10:15:00Z", [[b, 15, 110]]);
    await ingestSnapshotRun(r2);
    const inferred = (await events(b.id)).find((e) => e.source === "inferred")!;

    const fill = { tradeId: `${tag}-T1`, instrumentId: b.id, side: "buy" as const, qty: 5, price: 129.5, executedAt: "2026-11-03T10:05:00+05:30" };
    expect(await ingestFills("kite", [fill])).toEqual({ inserted: 1, superseded: 1 });
    expect(await ingestFills("kite", [fill])).toEqual({ inserted: 0, superseded: 0 });
    const links = await db.select().from(ledgerSupersessions).where(eq(ledgerSupersessions.supersededId, inferred.id));
    expect(links.map((l) => l.supersedingId)).toEqual([eventId(`fill:${tag}-T1`)]);

    await ingestSnapshotRun(r2); // the replay now explains the snapshot: nothing new
    expect(await events(b.id)).toHaveLength(3);
    expect(await qtyOf(b.id)).toBe(15);
  });

  it("top-up lag: no event and a pending_lag review item; the next run resolves it", async () => {
    const c = await mk("LAG");
    await ingestSnapshotRun(await run("kite", "2026-11-02T10:15:00Z", [[c, 10, 100]]));
    await ingestFills("kite", [
      { tradeId: `${tag}-T2`, instrumentId: c.id, side: "buy", qty: 5, price: 120, executedAt: "2026-11-03T10:00:00+05:30" },
    ]);
    // 15:45 IST the same day: broker still shows 10.
    expect((await ingestSnapshotRun(await run("kite", "2026-11-03T10:15:00Z", [[c, 10, 100]]))).inserted).toBe(0);
    expect(await events(c.id)).toHaveLength(2);
    expect(await review(c.id)).toEqual([expect.objectContaining({ kind: "pending_lag", resolvedAt: null })]);

    await ingestSnapshotRun(await run("kite", "2026-11-04T10:15:00Z", [[c, 15, 106.67]]));
    expect(await events(c.id)).toHaveLength(2);
    const [item] = await review(c.id);
    expect(item.resolvedAt).not.toBeNull();
    expect(item.resolvedBy).toBe("ingest");
  });

  it("split history is fetched on demand before inference: split event, no buy", async () => {
    const d = await mk("SPLIT");
    splits[`${prefix}SPLIT.NS`] = [{ exDate: "2026-11-05", num: 2, den: 1 }];
    await ingestSnapshotRun(await run("kite", "2026-10-20T10:15:00Z", [[d, 10, 100]]));
    expect(fetched("/chart/")).toBe(false); // bootstrap needs no action lookup

    await ingestSnapshotRun(await run("kite", "2026-11-06T10:15:00Z", [[d, 20, 50]]));
    expect(fetched(`/chart/${prefix}SPLIT.NS`)).toBe(true);
    expect(await db.select().from(corporateActions).where(eq(corporateActions.instrumentId, d.id))).toHaveLength(1);
    const rows = await events(d.id);
    expect(rows.map((e) => e.type).sort()).toEqual(["opening", "split"]);
    expect(rows.find((e) => e.type === "split")).toMatchObject({
      sourceRef: `action:${d.id}:2026-11-05`,
      exDate: "2026-11-05",
      ratioNum: "2",
      ratioDen: "1",
    });
    expect(await qtyOf(d.id)).toBe(20);
  });

  it("Console CSV supersedes the opening, copies refs onto the CSV buys, reconciles, and re-imports as a no-op", async () => {
    const e = await mk("INFY");
    await ingestSnapshotRun(await run("kite", "2026-11-09T10:15:00Z", [[e, 10, 1626.4]]));
    const opening = eventId(`opening:kite:${e.id}`);
    const text = fixture.replaceAll("INFY,", `${prefix}INFY,`).replace(/,(5\d{7}),/g, `,$1${tag},`);
    const copier = vi.fn(async () => {});
    REF_COPIERS.push(copier);
    try {
      expect(await importConsoleCsv(text, owner)).toEqual({ inserted: 4, superseded: 1, unexplained: [] });
    } finally {
      REF_COPIERS.splice(REF_COPIERS.indexOf(copier), 1);
    }
    const buys = ["56789012", "57890123", "59012345"].map((t) => eventId(`csv:${t}${tag}`));
    expect(copier).toHaveBeenCalledOnce();
    expect(copier.mock.calls[0]).toEqual([expect.anything(), new Map([[opening, buys]])]);
    expect(fetched(`/chart/${prefix}INFY.NS`)).toBe(true); // split history from the first trade on

    const rows = await events(e.id);
    expect(rows.filter((r) => r.source === "csv")).toHaveLength(4);
    const state = await getLedgerState([e.id]);
    expect(state.positions[e.id].qty).toBe(10);
    expect(state.openLots.every((l) => l.eventId !== opening)).toBe(true);

    expect(await importConsoleCsv(text, owner)).toEqual({ inserted: 0, superseded: 0, unexplained: [] });
  });

  it("all-or-nothing: a malformed CSV writes nothing; a failure inside the transaction rolls back; viewers are refused", async () => {
    const bad = [
      fixture.split("\n")[0],
      `${prefix}BAD,INE000000000,2024-01-15,NSE,EQ,EQ,buy,false,10,100,${tag}1,1,2024-01-15T09:21:44`,
      `${prefix}BAD,INE000000000,2024-01-16,NSE,EQ,EQ,buy,false,ten,100,${tag}2,2,2024-01-16T09:21:44`,
    ].join("\n");
    const r = await importConsoleCsv(bad, owner);
    expect(r).toEqual({ errors: [{ row: 3, message: 'bad quantity "ten"' }] });
    expect(await db.select().from(instruments).where(eq(instruments.brokerSymbol, `${prefix}BAD`))).toEqual([]);

    const f = await mk("ROLL");
    await ingestSnapshotRun(await run("kite", "2026-11-09T10:15:00Z", [[f, 10, 1626.4]]));
    const text = fixture.replaceAll("INFY,", `${prefix}ROLL,`).replace(/,(5\d{7}),/g, `,$1R${tag},`);
    const boom = async () => {
      throw new Error("copier failed");
    };
    REF_COPIERS.push(boom);
    try {
      await expect(importConsoleCsv(text, owner)).rejects.toThrow("copier failed");
    } finally {
      REF_COPIERS.splice(REF_COPIERS.indexOf(boom), 1);
    }
    expect((await events(f.id)).map((e) => e.source)).toEqual(["opening"]);
    expect(
      await db.select().from(ledgerSupersessions).where(inArray(ledgerSupersessions.supersededId, [eventId(`opening:kite:${f.id}`)])),
    ).toEqual([]);

    await expect(importConsoleCsv(text, { kind: "viewer", hideAmounts: false, via: "share-link" })).rejects.toThrow("Forbidden");
  });

  it("USD snapshot: FX is fetched before the transaction and stored, never null", async () => {
    const u = await mk("FXU", "US");
    await ingestSnapshotRun(await run("indmoney", "2002-03-08T21:00:00Z", [[u, 3, 150]]));
    expect(fetched("frankfurter")).toBe(true);
    const [row] = await events(u.id);
    expect(row).toMatchObject({ type: "opening", date: "2002-03-08", currency: "USD", fxRateInr: "48.86", broker: "indmoney" });
  });

  it("US history import supersedes the US opening and uses trade-date (forward-filled) FX", async () => {
    const v = await mk("USH", "US");
    await ingestSnapshotRun(await run("indmoney", "2002-03-15T21:00:00Z", [[v, 3, 156.67]]));
    const text = [
      "date,symbol,side,quantity,price,order_id",
      `2002-03-09,${prefix}USH,BUY,2,150,${tag}-O1`, // Saturday → Friday's rate
      `2002-03-11,${prefix}USH,BUY,1,170,${tag}-O2`,
    ].join("\n");
    expect(await importUsHistory(text, owner)).toEqual({ inserted: 2, superseded: 1, unexplained: [] });

    const rows = await events(v.id);
    const fx = Object.fromEntries(rows.filter((r) => r.source === "us_history").map((r) => [r.date, r.fxRateInr]));
    expect(fx).toEqual({ "2002-03-09": "48.86", "2002-03-11": "48.9" });
    const links = await db
      .select()
      .from(ledgerSupersessions)
      .where(and(eq(ledgerSupersessions.supersededId, eventId(`opening:indmoney:${v.id}`))));
    expect(links).toHaveLength(2);
    expect(await qtyOf(v.id)).toBe(3);
  });
});
