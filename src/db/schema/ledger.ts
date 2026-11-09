import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { brokerEnum } from "./brokers";
import { currencyEnum, instruments } from "./market";
import { syncRuns } from "./ops";

// Event-sourced ledger (docs/adr/0005). Pure logic lives in src/lib/ledger; this is storage only.

export const ledgerEventTypeEnum = pgEnum("ledger_event_type", ["buy", "sell", "split", "bonus", "dividend", "opening"]);
export const ledgerEventSourceEnum = pgEnum("ledger_event_source", [
  "fill",
  "csv",
  "inferred",
  "manual",
  "opening",
  "us_history",
  "action",
]);

/**
 * Append-only. `id` is derived from `source_ref` (src/lib/ledger/queries.ts eventId), so
 * supersession links can be planned before insert and re-ingesting maps to the same row.
 * Superseded rows stay; replay skips them via ledger_supersessions.
 */
export const ledgerEvents = pgTable(
  "ledger_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instruments.id, { onDelete: "cascade" }),
    broker: brokerEnum("broker"),
    type: ledgerEventTypeEnum("type").notNull(),
    // Trade date; for a bonus, the allotment (credit) date.
    date: date("date").notNull(),
    exDate: date("ex_date"),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    qty: numeric("qty", { mode: "string" }).notNull(),
    price: numeric("price", { mode: "string" }).notNull(),
    currency: currencyEnum("currency").notNull(),
    fxRateInr: numeric("fx_rate_inr", { mode: "string" }).notNull(),
    source: ledgerEventSourceEnum("source").notNull(),
    sourceRef: text("source_ref").notNull(),
    approximate: boolean("approximate").notNull().default(false),
    ratioNum: numeric("ratio_num", { mode: "string" }),
    ratioDen: numeric("ratio_den", { mode: "string" }),
    anomaly: text("anomaly"),
    // Dividend events only (U17): `price` is the NET per-share cash (after withholding),
    // `gross_amount` = qty × gross per share, `withholding_rate` the fraction withheld.
    grossAmount: numeric("gross_amount", { mode: "string" }),
    withholdingRate: numeric("withholding_rate", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("ledger_events_source_ref_uq").on(t.sourceRef),
    index("ledger_events_instrument_date_idx").on(t.instrumentId, t.date),
    check("ledger_events_fx_positive", sql`${t.fxRateInr} > 0`),
  ],
);

/** One superseded event → many superseding (one opening → three CSV buys). */
export const ledgerSupersessions = pgTable(
  "ledger_supersessions",
  {
    supersededId: uuid("superseded_id")
      .notNull()
      .references(() => ledgerEvents.id, { onDelete: "cascade" }),
    supersedingId: uuid("superseding_id")
      .notNull()
      .references(() => ledgerEvents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.supersededId, t.supersedingId] })],
);

/**
 * Broker holdings per sync run (U10 writes, U11 ingests). Keyed by run, not date
 * (adopted fix): two Kite runs a day each keep their own snapshot. qty includes t1_qty.
 */
export const holdingSnapshots = pgTable(
  "holding_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => syncRuns.id, { onDelete: "cascade" }),
    broker: brokerEnum("broker").notNull(),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instruments.id, { onDelete: "cascade" }),
    takenAt: timestamp("taken_at", { withTimezone: true }).notNull(),
    qty: numeric("qty", { mode: "string" }).notNull(),
    t1Qty: numeric("t1_qty", { mode: "string" }).notNull().default("0"),
    avgPrice: numeric("avg_price", { mode: "string" }).notNull(),
    ltp: numeric("ltp", { mode: "string" }),
    raw: jsonb("raw"),
  },
  (t) => [
    unique("holding_snapshots_run_instrument_uq").on(t.runId, t.instrumentId),
    index("holding_snapshots_instrument_taken_at_idx").on(t.instrumentId, t.takenAt.desc()),
  ],
);

export const reviewKindEnum = pgEnum("ledger_review_kind", [
  "pending_lag",
  "unexplained",
  "oversell",
  "approximate_sell",
  "unexplained_opening",
  "cost_mismatch",
  "price_fallback",
  "exceeds_broker",
]);

/** Owner review queue (U18 renders it). At most one open item per (instrument, kind). */
export const ledgerReviewQueue = pgTable(
  "ledger_review_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instruments.id, { onDelete: "cascade" }),
    kind: reviewKindEnum("kind").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
  },
  (t) => [
    uniqueIndex("ledger_review_queue_open_uq")
      .on(t.instrumentId, t.kind)
      .where(sql`${t.resolvedAt} is null`),
  ],
);
