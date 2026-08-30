CREATE TABLE "mission_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"reporter_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"previous_mission_status" text NOT NULL,
	"summary" text NOT NULL,
	"admin_notes" text,
	"resolution" text,
	"refund_amount_cents" integer DEFAULT 0 NOT NULL,
	"payout_amount_cents" integer DEFAULT 0 NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "action_label" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "action_url" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mission_cases" ADD CONSTRAINT "mission_cases_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_cases" ADD CONSTRAINT "mission_cases_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_cases" ADD CONSTRAINT "mission_cases_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mission_cases_mission_idx" ON "mission_cases" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "mission_cases_status_idx" ON "mission_cases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "mission_cases_reporter_idx" ON "mission_cases" USING btree ("reporter_id");