ALTER TABLE "missions" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "archived_reason" text;--> statement-breakpoint
CREATE INDEX "missions_archived_idx" ON "missions" USING btree ("archived_at");--> statement-breakpoint
CREATE TABLE "operational_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"severity" text DEFAULT 'error' NOT NULL,
	"category" text NOT NULL,
	"message" text NOT NULL,
	"fingerprint" text NOT NULL,
	"context_json" text,
	"status" text DEFAULT 'open' NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"alerted_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "operational_events" ADD CONSTRAINT "operational_events_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operational_events_fingerprint_idx" ON "operational_events" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "operational_events_status_idx" ON "operational_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "operational_events_last_seen_idx" ON "operational_events" USING btree ("last_seen_at");
