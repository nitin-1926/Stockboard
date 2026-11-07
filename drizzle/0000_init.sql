CREATE TYPE "public"."asset_class" AS ENUM('equity', 'etf', 'mutual_fund', 'other');--> statement-breakpoint
CREATE TYPE "public"."currency" AS ENUM('INR', 'USD');--> statement-breakpoint
CREATE TYPE "public"."market" AS ENUM('IN', 'US');--> statement-breakpoint
CREATE TYPE "public"."price_source" AS ENUM('yahoo', 'mcp', 'broker');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('running', 'completed', 'failed', 'skipped', 'holiday');--> statement-breakpoint
CREATE TABLE "fx_daily" (
	"date" date PRIMARY KEY NOT NULL,
	"usd_inr" numeric NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market" "market" NOT NULL,
	"exchange" text NOT NULL,
	"broker_symbol" text NOT NULL,
	"yahoo_symbol" text,
	"yahoo_symbol_override" text,
	"name" text NOT NULL,
	"sector" text,
	"industry" text,
	"sector_overridden" boolean DEFAULT false NOT NULL,
	"market_cap" numeric,
	"asset_class" "asset_class" DEFAULT 'equity' NOT NULL,
	"currency" "currency" NOT NULL,
	"is_benchmark" boolean DEFAULT false NOT NULL,
	"price_unavailable" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instruments_market_broker_symbol_uq" UNIQUE("market","broker_symbol")
);
--> statement-breakpoint
CREATE TABLE "price_latest" (
	"instrument_id" uuid PRIMARY KEY NOT NULL,
	"price" numeric NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"source" "price_source" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prices_daily" (
	"instrument_id" uuid NOT NULL,
	"date" date NOT NULL,
	"open" numeric,
	"high" numeric,
	"low" numeric,
	"close" numeric NOT NULL,
	"adj_close" numeric,
	"volume" numeric,
	CONSTRAINT "prices_daily_instrument_id_date_pk" PRIMARY KEY("instrument_id","date")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job" text NOT NULL,
	"broker" text,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"cursor" jsonb
);
--> statement-breakpoint
ALTER TABLE "price_latest" ADD CONSTRAINT "price_latest_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices_daily" ADD CONSTRAINT "prices_daily_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_runs_job_started_at_idx" ON "sync_runs" USING btree ("job","started_at" DESC NULLS LAST);