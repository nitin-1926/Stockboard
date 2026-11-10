CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_name_uq" UNIQUE("name"),
	CONSTRAINT "tags_name_lower" CHECK ("tags"."name" = lower("tags"."name") and length("tags"."name") between 1 and 40)
);
--> statement-breakpoint
CREATE TABLE "watch_item_tags" (
	"watch_item_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "watch_item_tags_watch_item_id_tag_id_pk" PRIMARY KEY("watch_item_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "watch_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"price_at_add" numeric,
	"price_at_add_source" text DEFAULT 'none' NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"archived_at" timestamp with time zone,
	"linked_buy_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watch_items_price_positive" CHECK ("watch_items"."price_at_add" is null or "watch_items"."price_at_add" > 0),
	CONSTRAINT "watch_items_created_by_lower" CHECK ("watch_items"."created_by" = lower("watch_items"."created_by"))
);
--> statement-breakpoint
ALTER TABLE "watch_item_tags" ADD CONSTRAINT "watch_item_tags_watch_item_id_watch_items_id_fk" FOREIGN KEY ("watch_item_id") REFERENCES "public"."watch_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_item_tags" ADD CONSTRAINT "watch_item_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_items" ADD CONSTRAINT "watch_items_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_items" ADD CONSTRAINT "watch_items_linked_buy_event_id_ledger_events_id_fk" FOREIGN KEY ("linked_buy_event_id") REFERENCES "public"."ledger_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "watch_items_active_instrument_uq" ON "watch_items" USING btree ("instrument_id") WHERE "watch_items"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "watch_items_linked_buy_idx" ON "watch_items" USING btree ("linked_buy_event_id");