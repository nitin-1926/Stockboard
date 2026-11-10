import { sql } from "drizzle-orm";
import { check, index, pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { ledgerEvents } from "./ledger";
import { watchItems } from "./watch";

// Buckets (U15): many-to-many over real buy events (buy or opening) and watch items (paper).
// Membership is on the event, not the symbol, so a re-buy can land in another bucket.

/** Theme chart tokens a bucket may use (globals.css `--chart-N`). */
export const BUCKET_COLORS = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"] as const;
export type BucketColor = (typeof BUCKET_COLORS)[number];

/**
 * Names are unique case-insensitively among live buckets; archiving (owner-only delete)
 * frees the name. `created_by` is the actor's lowercased email (edit_own resource owner).
 */
export const buckets = pgTable(
  "buckets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    color: text("color").notNull().default("chart-1"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("buckets_live_name_ci_uq")
      .on(sql`lower(${t.name})`)
      .where(sql`${t.archivedAt} is null`),
    check("buckets_name_len", sql`length(trim(${t.name})) between 1 and 60`),
    check("buckets_color", sql`${t.color} in ('chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5')`),
    check("buckets_created_by_lower", sql`${t.createdBy} = lower(${t.createdBy})`),
  ],
);

export const bucketMemberTypeEnum = pgEnum("bucket_member_type", ["buy_event", "watch_item"]);

/** Exactly one ref is set, matching member_type. */
export const bucketMembers = pgTable(
  "bucket_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bucketId: uuid("bucket_id")
      .notNull()
      .references(() => buckets.id, { onDelete: "cascade" }),
    memberType: bucketMemberTypeEnum("member_type").notNull(),
    buyEventId: uuid("buy_event_id").references(() => ledgerEvents.id, { onDelete: "cascade" }),
    watchItemId: uuid("watch_item_id").references(() => watchItems.id, { onDelete: "cascade" }),
    addedBy: text("added_by").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("bucket_members_bucket_buy_uq").on(t.bucketId, t.buyEventId),
    unique("bucket_members_bucket_watch_uq").on(t.bucketId, t.watchItemId),
    index("bucket_members_buy_idx").on(t.buyEventId),
    index("bucket_members_watch_idx").on(t.watchItemId),
    check(
      "bucket_members_one_ref",
      sql`(${t.memberType} = 'buy_event' and ${t.buyEventId} is not null and ${t.watchItemId} is null)
        or (${t.memberType} = 'watch_item' and ${t.watchItemId} is not null and ${t.buyEventId} is null)`,
    ),
  ],
);
