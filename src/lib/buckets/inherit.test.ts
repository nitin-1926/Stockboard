import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, pool } from "@/db";
import { bucketMembers, buckets, holdingSnapshots, instruments, syncRuns } from "@/db/schema";
import type { Actor } from "@/lib/auth/access";
import { importConsoleCsv, ingestFills, ingestSnapshotRun } from "@/lib/ledger/ingest";
import { eventId } from "@/lib/ledger/queries";
import { retry } from "@/lib/market/yahoo";

const fixture = readFileSync(new URL("../ledger/__fixtures__/console-tradebook.csv", import.meta.url), "utf8");

// Integration: real Neon DB, mocked network (Yahoo chart for the on-demand split check).
describe.skipIf(!process.env.DATABASE_URL)("bucket inheritance inside ingest (Neon, mocked network)", { timeout: 120_000 }, () => {
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const prefix = `TEST_${tag}_`;
  const job = `test-buckets-${tag}`;
  const owner: Actor = { kind: "owner", email: "owner@x.com", hideAmounts: false, via: "session" };
  const emptyChart = {
    chart: { result: [{ meta: { gmtoffset: 19800, currency: "INR" }, timestamp: [], indicators: { quote: [{}], adjclose: [{ adjclose: [] }] }, events: {} }] },
  };
  const fetchMock = vi.fn(async (input: string | URL) => {
    if (String(input).includes("/v8/finance/chart/")) return new Response(JSON.stringify(emptyChart), { status: 200 });
    throw new Error(`unexpected fetch ${input}`);
  });

  const mkInstrument = async (sym: string) =>
    (
      await db
        .insert(instruments)
        .values({ market: "IN", exchange: "NSE", brokerSymbol: prefix + sym, name: sym, currency: "INR" })
        .returning()
    )[0];
  const mkBucket = async (name: string) =>
    (await db.insert(buckets).values({ name: `${prefix}${name}`, createdBy: "owner@x.com" }).returning())[0];
  const tagEvent = (bucketId: string, buyEventId: string) =>
    db.insert(bucketMembers).values({ bucketId, memberType: "buy_event", buyEventId, addedBy: "owner@x.com" });
  const bucketsOf = async (ev: string) =>
    (await db.select({ b: bucketMembers.bucketId }).from(bucketMembers).where(eq(bucketMembers.buyEventId, ev))).map((r) => r.b).sort();
  const fill = (instrumentId: string, ref: string, day: string, side: "buy" | "sell", qty = 5, price = 100) => ({
    tradeId: `${tag}-${ref}`,
    instrumentId,
    side,
    qty,
    price,
    executedAt: `${day}T10:05:00+05:30`,
  });
  const fillId = (ref: string) => eventId(`fill:${tag}-${ref}`);

  beforeEach(() => {
    retry.baseMs = 0;
    vi.stubGlobal("fetch", fetchMock);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    // Instruments cascade to events (→ memberships); buckets cascade to the rest.
    await db.delete(instruments).where(like(instruments.brokerSymbol, `${prefix}%`));
    await db.delete(buckets).where(like(buckets.name, `${prefix}%`));
    await db.delete(syncRuns).where(eq(syncRuns.job, job));
    const left = await db.select().from(buckets).where(like(buckets.name, `${prefix}%`));
    expect(left).toHaveLength(0);
    await pool.end();
  });

  it("a March re-buy inherits the bucket of the open January lot", async () => {
    const i = await mkInstrument("JAN");
    const picks = await mkBucket("Manager picks");
    await ingestFills("kite", [fill(i.id, "J1", "2026-01-12", "buy")]);
    await tagEvent(picks.id, fillId("J1"));
    await ingestFills("kite", [fill(i.id, "M1", "2026-03-16", "buy")]);
    expect(await bucketsOf(fillId("M1"))).toEqual([picks.id]);
  });

  it("open lots in two buckets → the new buy inherits both", async () => {
    const i = await mkInstrument("TWO");
    const [picks, self] = [await mkBucket("Picks 2"), await mkBucket("Self 2")];
    await ingestFills("kite", [fill(i.id, "T1", "2026-01-12", "buy"), fill(i.id, "T2", "2026-02-02", "buy")]);
    await tagEvent(picks.id, fillId("T1"));
    await tagEvent(self.id, fillId("T2"));
    await ingestFills("kite", [fill(i.id, "T3", "2026-03-16", "buy")]);
    expect(await bucketsOf(fillId("T3"))).toEqual([picks.id, self.id].sort());
  });

  it("fully sold, then re-bought → no inheritance", async () => {
    const i = await mkInstrument("EXIT");
    const picks = await mkBucket("Picks 3");
    await ingestFills("kite", [fill(i.id, "E1", "2026-01-12", "buy")]);
    await tagEvent(picks.id, fillId("E1"));
    await ingestFills("kite", [fill(i.id, "E2", "2026-02-10", "sell", 5, 120)]);
    await ingestFills("kite", [fill(i.id, "E3", "2026-03-16", "buy")]);
    expect(await bucketsOf(fillId("E3"))).toEqual([]);
    expect(await bucketsOf(fillId("E1"))).toEqual([picks.id]); // the sold lot keeps its bucket
  });

  it("a bucketed opening superseded by a Console CSV → every CSV buy carries the membership", async () => {
    const i = await mkInstrument("INFY");
    const picks = await mkBucket("Picks 4");
    const [r] = await db.insert(syncRuns).values({ job, broker: "kite", status: "completed" }).returning();
    await db
      .insert(holdingSnapshots)
      .values({ runId: r.id, broker: "kite", instrumentId: i.id, takenAt: new Date("2026-11-09T10:15:00Z"), qty: "10", avgPrice: "1626.4" });
    await ingestSnapshotRun(r.id);
    const opening = eventId(`opening:kite:${i.id}`);
    await tagEvent(picks.id, opening);

    const text = fixture.replaceAll("INFY,", `${prefix}INFY,`).replace(/,(5\d{7}),/g, `,$1${tag},`);
    expect(await importConsoleCsv(text, owner)).toMatchObject({ superseded: 1 });
    const csvBuys = ["56789012", "57890123", "59012345"].map((t) => eventId(`csv:${t}${tag}`));
    for (const b of csvBuys) expect(await bucketsOf(b)).toEqual([picks.id]);
    // The sell is not a member; the opening's own row stays as history.
    expect(await bucketsOf(eventId(`csv:58901234${tag}`))).toEqual([]);
    const all = await db.select().from(bucketMembers).where(inArray(bucketMembers.buyEventId, [opening, ...csvBuys]));
    expect(all).toHaveLength(4);
  });
});
