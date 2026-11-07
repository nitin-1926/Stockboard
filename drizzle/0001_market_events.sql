CREATE TYPE "public"."corporate_action_kind" AS ENUM('split', 'bonus');--> statement-breakpoint
CREATE TABLE "corporate_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"ex_date" date NOT NULL,
	"kind" "corporate_action_kind" DEFAULT 'split' NOT NULL,
	"numerator" numeric NOT NULL,
	"denominator" numeric NOT NULL,
	"source" text DEFAULT 'yahoo' NOT NULL,
	"confirmed_by_owner" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "corporate_actions_instrument_ex_date_uq" UNIQUE("instrument_id","ex_date")
);
--> statement-breakpoint
CREATE TABLE "dividends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"ex_date" date NOT NULL,
	"pay_date" date,
	"amount_per_share" numeric NOT NULL,
	"currency" "currency" NOT NULL,
	"source" text DEFAULT 'yahoo' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dividends_instrument_ex_date_uq" UNIQUE("instrument_id","ex_date")
);
--> statement-breakpoint
ALTER TABLE "corporate_actions" ADD CONSTRAINT "corporate_actions_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dividends" ADD CONSTRAINT "dividends_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;