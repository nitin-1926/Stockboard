CREATE TYPE "public"."bucket_member_type" AS ENUM('buy_event', 'watch_item');--> statement-breakpoint
CREATE TABLE "bucket_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket_id" uuid NOT NULL,
	"member_type" "bucket_member_type" NOT NULL,
	"buy_event_id" uuid,
	"watch_item_id" uuid,
	"added_by" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bucket_members_bucket_buy_uq" UNIQUE("bucket_id","buy_event_id"),
	CONSTRAINT "bucket_members_bucket_watch_uq" UNIQUE("bucket_id","watch_item_id"),
	CONSTRAINT "bucket_members_one_ref" CHECK (("bucket_members"."member_type" = 'buy_event' and "bucket_members"."buy_event_id" is not null and "bucket_members"."watch_item_id" is null)
        or ("bucket_members"."member_type" = 'watch_item' and "bucket_members"."watch_item_id" is not null and "bucket_members"."buy_event_id" is null))
);
--> statement-breakpoint
CREATE TABLE "buckets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"color" text DEFAULT 'chart-1' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "buckets_name_len" CHECK (length(trim("buckets"."name")) between 1 and 60),
	CONSTRAINT "buckets_color" CHECK ("buckets"."color" in ('chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5')),
	CONSTRAINT "buckets_created_by_lower" CHECK ("buckets"."created_by" = lower("buckets"."created_by"))
);
--> statement-breakpoint
ALTER TABLE "bucket_members" ADD CONSTRAINT "bucket_members_bucket_id_buckets_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "public"."buckets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bucket_members" ADD CONSTRAINT "bucket_members_buy_event_id_ledger_events_id_fk" FOREIGN KEY ("buy_event_id") REFERENCES "public"."ledger_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bucket_members" ADD CONSTRAINT "bucket_members_watch_item_id_watch_items_id_fk" FOREIGN KEY ("watch_item_id") REFERENCES "public"."watch_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bucket_members_buy_idx" ON "bucket_members" USING btree ("buy_event_id");--> statement-breakpoint
CREATE INDEX "bucket_members_watch_idx" ON "bucket_members" USING btree ("watch_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "buckets_live_name_ci_uq" ON "buckets" USING btree (lower("name")) WHERE "buckets"."archived_at" is null;