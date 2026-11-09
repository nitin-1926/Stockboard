CREATE TYPE "public"."ledger_event_source" AS ENUM('fill', 'csv', 'inferred', 'manual', 'opening', 'us_history', 'action');--> statement-breakpoint
CREATE TYPE "public"."ledger_event_type" AS ENUM('buy', 'sell', 'split', 'bonus', 'dividend', 'opening');--> statement-breakpoint
CREATE TYPE "public"."ledger_review_kind" AS ENUM('pending_lag', 'unexplained', 'oversell', 'approximate_sell', 'unexplained_opening', 'cost_mismatch', 'price_fallback', 'exceeds_broker');--> statement-breakpoint
CREATE TABLE "holding_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"broker" "broker" NOT NULL,
	"instrument_id" uuid NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"qty" numeric NOT NULL,
	"t1_qty" numeric DEFAULT '0' NOT NULL,
	"avg_price" numeric NOT NULL,
	"ltp" numeric,
	"raw" jsonb,
	CONSTRAINT "holding_snapshots_run_instrument_uq" UNIQUE("run_id","instrument_id")
);
--> statement-breakpoint
CREATE TABLE "ledger_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"broker" "broker",
	"type" "ledger_event_type" NOT NULL,
	"date" date NOT NULL,
	"ex_date" date,
	"executed_at" timestamp with time zone,
	"qty" numeric NOT NULL,
	"price" numeric NOT NULL,
	"currency" "currency" NOT NULL,
	"fx_rate_inr" numeric NOT NULL,
	"source" "ledger_event_source" NOT NULL,
	"source_ref" text NOT NULL,
	"approximate" boolean DEFAULT false NOT NULL,
	"ratio_num" numeric,
	"ratio_den" numeric,
	"anomaly" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_events_source_ref_uq" UNIQUE("source_ref"),
	CONSTRAINT "ledger_events_fx_positive" CHECK ("ledger_events"."fx_rate_inr" > 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_review_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"kind" "ledger_review_kind" NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text
);
--> statement-breakpoint
CREATE TABLE "ledger_supersessions" (
	"superseded_id" uuid NOT NULL,
	"superseding_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_supersessions_superseded_id_superseding_id_pk" PRIMARY KEY("superseded_id","superseding_id")
);
--> statement-breakpoint
ALTER TABLE "holding_snapshots" ADD CONSTRAINT "holding_snapshots_run_id_sync_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_snapshots" ADD CONSTRAINT "holding_snapshots_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_events" ADD CONSTRAINT "ledger_events_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_review_queue" ADD CONSTRAINT "ledger_review_queue_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_supersessions" ADD CONSTRAINT "ledger_supersessions_superseded_id_ledger_events_id_fk" FOREIGN KEY ("superseded_id") REFERENCES "public"."ledger_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_supersessions" ADD CONSTRAINT "ledger_supersessions_superseding_id_ledger_events_id_fk" FOREIGN KEY ("superseding_id") REFERENCES "public"."ledger_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "holding_snapshots_instrument_taken_at_idx" ON "holding_snapshots" USING btree ("instrument_id","taken_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ledger_events_instrument_date_idx" ON "ledger_events" USING btree ("instrument_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_review_queue_open_uq" ON "ledger_review_queue" USING btree ("instrument_id","kind") WHERE "ledger_review_queue"."resolved_at" is null;