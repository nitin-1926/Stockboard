import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, pool } from "@/db";
import { instruments, tags, watchItems, watchItemTags } from "@/db/schema";
import type { Actor } from "@/lib/auth/access";
import type { SearchHit } from "@/lib/market/search";
import { retry } from "@/lib/market/yahoo";
import { addWatchItem, archiveWatchItem, importBrokerWatchlist, importPasted, updateWatchItem } from "./actions";

// Integration: real Neon DB, mocked Yahoo (search + chart). Symbols carry a TEST_<tag>_
// prefix so nothing collides with real instruments; the paste case is "TCS, INFY, XYZNOTREAL".
describe.skipIf(!process.env.DATABASE_URL)("watch actions (Neon, mocked Yahoo)", { timeout: 120_000 }, () => {
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const prefix = `TEST_${tag}_`;
  const low = tag.toLowerCase();
  const ownerEmail = `owner-${low}@test.invalid`;
  const owner: Actor = { kind: "owner", email: ownerEmail, hideAmounts: false, via: "session" };
  const contributor: Actor = { kind: "contributor", email: `c-${low}@test.invalid`, hideAmounts: false, via: "session" };
  const viewer: Actor = { kind: "viewer", email: `v-${low}@test.invalid`, hideAmounts: false, via: "session" };
  const known = new Set(["TCS", "INFY", "HDFC", "ADDED", "DUP", "EDIT"].map((s) => prefix + s));

  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/finance/search") {
      const q = url.searchParams.get("q")!.toUpperCase();
      return json({ quotes: known.has(q) ? [{ symbol: `${q}.NS`, longname: `${q} Ltd`, exchange: "NSI", quoteType: "EQUITY" }] : [] });
    }
    if (url.pathname.startsWith("/v8/finance/chart/"))
      return json({ chart: { result: [{ meta: { regularMarketPrice: 3512.5, regularMarketTime: 1_794_384_000 }, timestamp: [], indicators: { quote: [{}] } }] } });
    throw new Error(`unexpected fetch ${url}`);
  });
  const hit = (sym: string): SearchHit => ({
    symbol: `${prefix}${sym}.NS`,
    name: `${sym} Ltd`,
    exchange: "NSE",
    market: "IN",
    currency: "INR",
    type: "equity",
  });
  const itemsOf = async (sym: string) => {
    const [i] = await db.select().from(instruments).where(eq(instruments.brokerSymbol, prefix + sym));
    return i ? db.select().from(watchItems).where(eq(watchItems.instrumentId, i.id)) : [];
  };
  const tagsOf = async (itemId: string) =>
    (
      await db
        .select({ name: tags.name })
        .from(watchItemTags)
        .innerJoin(tags, eq(tags.id, watchItemTags.tagId))
        .where(eq(watchItemTags.watchItemId, itemId))
    )
      .map((t) => t.name)
      .sort();

  beforeEach(() => {
    retry.baseMs = 0;
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OWNER_EMAIL", ownerEmail);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    // Cascades to watch items (→ item tags) and price_latest.
    await db.delete(instruments).where(like(instruments.brokerSymbol, `${prefix}%`));
    await db.delete(tags).where(inArray(tags.createdBy, [ownerEmail, contributor.email!]));
    await pool.end();
  });

  it("a contributor's add is stamped with their email and the latest price", async () => {
    const r = await addWatchItem(contributor, hit("ADDED"), { tags: [`T-${low}`, ` t-${low} `] });
    expect(r.created).toBe(true);
    expect(r.item).toMatchObject({ createdBy: contributor.email, priceAtAdd: "3512.5", priceAtAddSource: "yahoo", archivedAt: null });
    expect(await tagsOf(r.item.id)).toEqual([`t-${low}`]);
  });

  it("a viewer's add is rejected and writes nothing", async () => {
    await expect(addWatchItem(viewer, hit("VIEWER"))).rejects.toThrow("Forbidden");
    await expect(importPasted(viewer, `${prefix}TCS`)).rejects.toThrow("Forbidden");
    expect(await itemsOf("VIEWER")).toEqual([]);
  });

  it("a contributor can't edit or archive the owner's item, but can edit their own", async () => {
    const { item } = await addWatchItem(owner, hit("EDIT"));
    await expect(updateWatchItem(contributor, item.id, { note: "mine now" })).rejects.toThrow("Forbidden");
    await expect(archiveWatchItem(contributor, item.id)).rejects.toThrow("Forbidden");
    expect((await itemsOf("EDIT"))[0]).toMatchObject({ note: null, archivedAt: null });

    const own = (await itemsOf("ADDED"))[0];
    await updateWatchItem(contributor, own.id, { priceAtAdd: 3400, note: " buy below 3300 ", tags: [`x-${low}`] });
    expect((await itemsOf("ADDED"))[0]).toMatchObject({ priceAtAdd: "3400", priceAtAddSource: "manual", note: "buy below 3300" });
    expect(await tagsOf(own.id)).toEqual([`x-${low}`]);

    await updateWatchItem(owner, item.id, { note: "owner may" });
    await archiveWatchItem(owner, item.id);
    expect((await itemsOf("EDIT"))[0].archivedAt).not.toBeNull();
  });

  it("adding an already-watched, non-archived instrument returns the existing item", async () => {
    const a = await addWatchItem(owner, hit("DUP"));
    const b = await addWatchItem(contributor, hit("DUP"), { priceAtAdd: 1 });
    expect(b).toEqual({ item: a.item, created: false });
    expect(await itemsOf("DUP")).toHaveLength(1);

    await archiveWatchItem(owner, a.item.id); // archived → a fresh add creates a new item
    expect((await addWatchItem(owner, hit("DUP"))).created).toBe(true);
    expect(await itemsOf("DUP")).toHaveLength(2);
  });

  it('paste "TCS, INFY, XYZNOTREAL" → 2 added, 1 unresolved; a re-paste reports them as already watched', async () => {
    const text = `${prefix}TCS, ${prefix}INFY\nXYZNOTREAL`;
    expect(await importPasted(contributor, text)).toEqual({
      added: [`${prefix}TCS`, `${prefix}INFY`],
      existing: [],
      unresolved: ["XYZNOTREAL"],
    });
    expect(await importPasted(owner, text, "IN")).toEqual({
      added: [],
      existing: [`${prefix}TCS`, `${prefix}INFY`],
      unresolved: ["XYZNOTREAL"],
    });
    expect((await itemsOf("TCS"))[0].createdBy).toBe(contributor.email);
  });

  it("importBrokerWatchlist is idempotent, tags source:<broker>, and respects an archive", async () => {
    // Already an instrument (from a sync), already watched by hand (gets the tag), and one search must resolve.
    const [held] = await db
      .insert(instruments)
      .values({ market: "IN", exchange: "NSE", brokerSymbol: `${prefix}HELD`, name: "Held", currency: "INR" })
      .returning();
    const manual = await addWatchItem(owner, hit("HDFC"));
    const list = [
      { symbol: `${prefix}HELD`, market: "IN" as const },
      { symbol: `${prefix}hdfc`, market: "IN" as const },
      { symbol: "NOPE", market: "IN" as const },
    ];

    const first = await importBrokerWatchlist("indmoney", list);
    expect(first).toEqual({ added: [`${prefix}HELD`], existing: [`${prefix}HDFC`], unresolved: ["NOPE"] });
    const second = await importBrokerWatchlist("indmoney", list);
    expect(second).toEqual({ added: [], existing: [`${prefix}HELD`, `${prefix}HDFC`], unresolved: ["NOPE"] });

    const heldItems = await db.select().from(watchItems).where(eq(watchItems.instrumentId, held.id));
    expect(heldItems).toHaveLength(1);
    expect(heldItems[0].createdBy).toBe(ownerEmail);
    expect(await tagsOf(heldItems[0].id)).toEqual(["source:indmoney"]);
    expect(await tagsOf(manual.item.id)).toEqual(["source:indmoney"]);

    await archiveWatchItem(owner, heldItems[0].id);
    expect((await importBrokerWatchlist("indmoney", list)).added).toEqual([]);
    expect(await db.select().from(watchItems).where(eq(watchItems.instrumentId, held.id))).toHaveLength(1);
  });
});
