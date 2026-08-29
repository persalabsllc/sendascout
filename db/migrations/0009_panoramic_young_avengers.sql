CREATE TABLE "mission_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"scout_id" uuid NOT NULL,
	"rating" integer NOT NULL,
	"review" text,
	"tip_cents" integer DEFAULT 0 NOT NULL,
	"tip_status" "payment_status" DEFAULT 'unpaid' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD COLUMN "rating_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD COLUMN "headshot_path" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_notifications_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sms_notifications_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sms_consented_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mission_reviews" ADD CONSTRAINT "mission_reviews_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_reviews" ADD CONSTRAINT "mission_reviews_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_reviews" ADD CONSTRAINT "mission_reviews_scout_id_users_id_fk" FOREIGN KEY ("scout_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mission_reviews_mission_idx" ON "mission_reviews" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "mission_reviews_scout_idx" ON "mission_reviews" USING btree ("scout_id");