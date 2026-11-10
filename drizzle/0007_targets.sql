CREATE TYPE "public"."target_input_mode" AS ENUM('abs', 'pct');--> statement-breakpoint
CREATE TYPE "public"."target_kind" AS ENUM('target', 'stop');--> statement-breakpoint
CREATE TYPE "public"."target_status" AS ENUM('pending', 'hit', 'stopped', 'expired', 'cancelled');--> statement-breakpoint
CREATE TABLE "targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"kind" "target_kind" NOT NULL,
	"price" numeric NOT NULL,
	"input_mode" "target_input_mode" DEFAULT 'abs' NOT NULL,
	"pct_value" numeric,
	"deadline" date,
	"set_by" text NOT NULL,
	"price_at_set" numeric NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "target_status" DEFAULT 'pending' NOT NULL,
	"resolved_at" date,
	"resolved_price" numeric,
	"best_price" numeric,
	"miss_pct" numeric,
	"replaced_by" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "targets_price_positive" CHECK ("targets"."price" > 0 and "targets"."price_at_set" > 0),
	CONSTRAINT "targets_set_by_lower" CHECK ("targets"."set_by" = lower("targets"."set_by")),
	CONSTRAINT "targets_pct_mode" CHECK (("targets"."input_mode" = 'pct' and "targets"."pct_value" is not null) or ("targets"."input_mode" = 'abs' and "targets"."pct_value" is null)),
	CONSTRAINT "targets_resolved" CHECK (("targets"."status" = 'pending') = ("targets"."resolved_at" is null))
);
--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_replaced_by_targets_id_fk" FOREIGN KEY ("replaced_by") REFERENCES "public"."targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "targets_instrument_idx" ON "targets" USING btree ("instrument_id");--> statement-breakpoint
CREATE INDEX "targets_pending_idx" ON "targets" USING btree ("status") WHERE "targets"."status" = 'pending';