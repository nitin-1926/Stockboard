CREATE TYPE "public"."journal_kind" AS ENUM('thesis', 'review', 'note');--> statement-breakpoint
CREATE TYPE "public"."journal_subject" AS ENUM('buy_event', 'watch_item', 'target');--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" "journal_subject" NOT NULL,
	"subject_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"kind" "journal_kind" NOT NULL,
	"body" text NOT NULL,
	"author" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "journal_entries_body_len" CHECK (length("journal_entries"."body") between 1 and 4000),
	CONSTRAINT "journal_entries_author_lower" CHECK ("journal_entries"."author" = lower("journal_entries"."author"))
);
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_entries_instrument_idx" ON "journal_entries" USING btree ("instrument_id");--> statement-breakpoint
CREATE INDEX "journal_entries_subject_idx" ON "journal_entries" USING btree ("subject_type","subject_id");