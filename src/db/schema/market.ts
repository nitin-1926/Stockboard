import {
  boolean,
  date,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// Money and quantity columns are Postgres `numeric` read/written as strings, so
// values never pass through JS floats. Arithmetic on them uses a decimal library
// (chosen in U12); never `Number()` a money column.

export const marketEnum = pgEnum("market", ["IN", "US"]);
export const currencyEnum = pgEnum("currency", ["INR", "USD"]);
export const assetClassEnum = pgEnum("asset_class", ["equity", "etf", "mutual_fund", "other"]);
export const priceSourceEnum = pgEnum("price_source", ["yahoo", "mcp", "broker"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const instruments = pgTable(
  "instruments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    market: marketEnum("market").notNull(),
    exchange: text("exchange").notNull(),
    brokerSymbol: text("broker_symbol").notNull(),
    yahooSymbol: text("yahoo_symbol"),
    yahooSymbolOverride: text("yahoo_symbol_override"),
    name: text("name").notNull(),
    sector: text("sector"),
    industry: text("industry"),
    sectorOverridden: boolean("sector_overridden").notNull().default(false),
    marketCap: numeric("market_cap", { mode: "string" }),
    assetClass: assetClassEnum("asset_class").notNull().default("equity"),
    currency: currencyEnum("currency").notNull(),
    isBenchmark: boolean("is_benchmark").notNull().default(false),
    priceUnavailable: boolean("price_unavailable").notNull().default(false),
    ...timestamps,
  },
  (t) => [unique("instruments_market_broker_symbol_uq").on(t.market, t.brokerSymbol)],
);

// RAW (unadjusted) OHLC as traded on that date. Split adjustment is done in code
// from corporate-action events, so a late-reported split never rewrites history.
// adj_close is Yahoo's value, kept for reference only. open/high/low are nullable
// because sources (Yahoo gaps, MCP close-only quotes) sometimes omit them.
export const pricesDaily = pgTable(
  "prices_daily",
  {
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instruments.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    open: numeric("open", { mode: "string" }),
    high: numeric("high", { mode: "string" }),
    low: numeric("low", { mode: "string" }),
    close: numeric("close", { mode: "string" }).notNull(),
    adjClose: numeric("adj_close", { mode: "string" }),
    volume: numeric("volume", { mode: "string" }),
  },
  (t) => [primaryKey({ columns: [t.instrumentId, t.date] })],
);

export const priceLatest = pgTable("price_latest", {
  instrumentId: uuid("instrument_id")
    .primaryKey()
    .references(() => instruments.id, { onDelete: "cascade" }),
  price: numeric("price", { mode: "string" }).notNull(),
  asOf: timestamp("as_of", { withTimezone: true }).notNull(),
  source: priceSourceEnum("source").notNull(),
  /** Close of the trading day before as_of's market date (day change). Null when the source gave none. */
  prevClose: numeric("prev_close", { mode: "string" }),
});

export const fxDaily = pgTable("fx_daily", {
  date: date("date").primaryKey(),
  usdInr: numeric("usd_inr", { mode: "string" }).notNull(),
  source: text("source").notNull(),
});

// Yahoo reports bonuses as splits, so every event lands as 'split'; the owner can
// reclassify it as 'bonus' (confirmed_by_owner). Ratio is numerator:denominator
// new:old shares, e.g. 2:1 for a 1:1 bonus.
export const corporateActionKindEnum = pgEnum("corporate_action_kind", ["split", "bonus"]);

export const corporateActions = pgTable(
  "corporate_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instruments.id, { onDelete: "cascade" }),
    exDate: date("ex_date").notNull(),
    kind: corporateActionKindEnum("kind").notNull().default("split"),
    numerator: numeric("numerator", { mode: "string" }).notNull(),
    denominator: numeric("denominator", { mode: "string" }).notNull(),
    source: text("source").notNull().default("yahoo"),
    confirmedByOwner: boolean("confirmed_by_owner").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("corporate_actions_instrument_ex_date_uq").on(t.instrumentId, t.exDate)],
);

// Gross per-share amount in the instrument's native currency, on the RAW share
// basis (same basis as prices_daily). Withholding is applied by the ledger.
export const dividends = pgTable(
  "dividends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instruments.id, { onDelete: "cascade" }),
    exDate: date("ex_date").notNull(),
    payDate: date("pay_date"),
    amountPerShare: numeric("amount_per_share", { mode: "string" }).notNull(),
    currency: currencyEnum("currency").notNull(),
    source: text("source").notNull().default("yahoo"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("dividends_instrument_ex_date_uq").on(t.instrumentId, t.exDate)],
);
