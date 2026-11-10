import { sql } from "drizzle-orm";
import { check, index, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { ledgerEvents } from "./ledger";
import { instruments } from "./market";

// Watch items (U14). The same rows are U15's paper bucket members: one notional unit
// bought at price_at_add on added_at. Archiving keeps the row (buckets may reference it).

/**
 * At most one active (non-archived) item per instrument. `created_by` is the actor's
 * lowercased email (the edit_own resource owner). `linked_buy_event_id` points at the
 * first real buy ingested after `added_at` (src/lib/watch/link-buys.ts).
 */
export const watchItems = pgTable(
  "watch_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instruments.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    priceAtAdd: numeric("price_at_add", { mode: "string" }),
    /** Where price_at_add came from: yahoo | latest | manual | none. */
    priceAtAddSource: text("price_at_add_source").notNull().default("none"),
    note: text("note"),
    createdBy: text("created_by").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    linkedBuyEventId: uuid("linked_buy_event_id").references(() => ledgerEvents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("watch_items_active_instrument_uq")
      .on(t.instrumentId)
      .where(sql`${t.archivedAt} is null`),
    index("watch_items_linked_buy_idx").on(t.linkedBuyEventId),
    check("watch_items_price_positive", sql`${t.priceAtAdd} is null or ${t.priceAtAdd} > 0`),
    check("watch_items_created_by_lower", sql`${t.createdBy} = lower(${t.createdBy})`),
  ],
);

/** Tags replace multiple lists. Names are stored lowercased, so "Defence" and "defence" are one tag. */
export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique("tags_name_uq"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("tags_name_lower", sql`${t.name} = lower(${t.name}) and length(${t.name}) between 1 and 40`)],
);

export const watchItemTags = pgTable(
  "watch_item_tags",
  {
    watchItemId: uuid("watch_item_id")
      .notNull()
      .references(() => watchItems.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.watchItemId, t.tagId] })],
);
