import { sql } from "drizzle-orm";
import { type AnyPgColumn, check, date, index, numeric, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { instruments } from "./market";

// Targets (U16). Several per symbol: a target (price to reach) or a stop (price not to
// fall to). Prices are ABSOLUTE on the raw basis of the day they were set (prices_daily is
// raw too); a later split is applied in code (src/lib/targets/evaluate.ts), never by
// rewriting the row. Resolved rows are immutable: editing inserts a new row and marks the
// old one `cancelled` with `replaced_by`, so history is kept.

export const targetKindEnum = pgEnum("target_kind", ["target", "stop"]);
export const targetInputModeEnum = pgEnum("target_input_mode", ["abs", "pct"]);
export const targetStatusEnum = pgEnum("target_status", ["pending", "hit", "stopped", "expired", "cancelled"]);

/**
 * `pct_value` is the signed fraction entered in % mode (0.2 = +20%), null in abs mode.
 * `set_by` is the actor's lowercased email (the edit_own resource owner and scorecard key).
 * `best_price` is the best price reached since set (highest high for a target, lowest low
 * for a stop), on the set-time basis; `miss_pct` = (best − price) / price once expired.
 */
export const targets = pgTable(
  "targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instruments.id, { onDelete: "cascade" }),
    kind: targetKindEnum("kind").notNull(),
    price: numeric("price", { mode: "string" }).notNull(),
    inputMode: targetInputModeEnum("input_mode").notNull().default("abs"),
    pctValue: numeric("pct_value", { mode: "string" }),
    deadline: date("deadline"),
    setBy: text("set_by").notNull(),
    priceAtSet: numeric("price_at_set", { mode: "string" }).notNull(),
    setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
    status: targetStatusEnum("status").notNull().default("pending"),
    resolvedAt: date("resolved_at"),
    resolvedPrice: numeric("resolved_price", { mode: "string" }),
    bestPrice: numeric("best_price", { mode: "string" }),
    missPct: numeric("miss_pct", { mode: "string" }),
    replacedBy: uuid("replaced_by").references((): AnyPgColumn => targets.id, { onDelete: "set null" }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("targets_instrument_idx").on(t.instrumentId),
    index("targets_pending_idx").on(t.status).where(sql`${t.status} = 'pending'`),
    check("targets_price_positive", sql`${t.price} > 0 and ${t.priceAtSet} > 0`),
    check("targets_set_by_lower", sql`${t.setBy} = lower(${t.setBy})`),
    check(
      "targets_pct_mode",
      sql`(${t.inputMode} = 'pct' and ${t.pctValue} is not null) or (${t.inputMode} = 'abs' and ${t.pctValue} is null)`,
    ),
    check("targets_resolved", sql`(${t.status} = 'pending') = (${t.resolvedAt} is null)`),
  ],
);
