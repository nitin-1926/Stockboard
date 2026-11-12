import { describe, expect, it } from "vitest";
import type { Actor } from "@/lib/auth/access";
import { buildEntries, type EntryRow } from "./journal";

const t0 = new Date("2026-11-01T06:00:00Z");
const row = (o: Partial<EntryRow>): EntryRow => ({
  id: "e1",
  subjectType: "watch_item",
  subjectId: "w1",
  kind: "thesis",
  body: "Margins turning.",
  author: "owner@x.com",
  createdAt: t0,
  updatedAt: t0,
  ...o,
});
const rows = [row({}), row({ id: "e2", author: "c@x.com", updatedAt: new Date(t0.getTime() + 3_600_000) })];

describe("buildEntries", () => {
  it("share-link viewers get no entries, with or without hide-amounts", () => {
    for (const hideAmounts of [true, false]) {
      const link: Actor = { kind: "viewer", hideAmounts, via: "share-link" };
      const out = buildEntries(rows, new Map(), link, "owner@x.com");
      expect(out).toEqual([]);
      expect(JSON.stringify(out)).not.toContain("Margins");
    }
  });

  it("a signed-in viewer reads entries (hide-amounts included) but edits none", () => {
    const viewer: Actor = { kind: "viewer", email: "v@x.com", hideAmounts: true, via: "session" };
    const out = buildEntries(rows, new Map(), viewer, "owner@x.com");
    expect(out.map((e) => [e.author, e.body, e.canEdit])).toEqual([
      ["owner@x.com", "Margins turning.", false],
      ["c@x.com", "Margins turning.", false],
    ]);
  });

  it("signed-in actors see emails; contributors may edit only their own; a later save is flagged edited", () => {
    const contributor: Actor = { kind: "contributor", email: "c@x.com", hideAmounts: false, via: "session" };
    const out = buildEntries(rows, new Map(), contributor, "owner@x.com");
    expect(out.map((e) => [e.author, e.canEdit, e.edited])).toEqual([
      ["owner@x.com", false, false],
      ["c@x.com", true, true],
    ]);
  });
});
