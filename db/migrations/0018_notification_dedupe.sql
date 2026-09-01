ALTER TABLE "notifications" ADD COLUMN "dedupe_key" text;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "provider_attempt_started_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_key_idx" ON "notifications" USING btree ("dedupe_key");
--> statement-breakpoint
CREATE TABLE "sent_message_events" (
	"message_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "alert_generation" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "preferred_scout_broadcast_generation" integer;
--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_alert_generation_check" CHECK ("missions"."alert_generation" >= 0);
--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_preferred_broadcast_generation_check" CHECK ("missions"."preferred_scout_broadcast_generation" IS NULL OR "missions"."preferred_scout_broadcast_generation" >= 0);
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD COLUMN "stripe_sync_generation" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD CONSTRAINT "scout_profiles_stripe_sync_generation_check" CHECK ("scout_profiles"."stripe_sync_generation" >= 0);
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD COLUMN "stripe_sync_completed_generation" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD COLUMN "stripe_sync_lease_token" text;
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD COLUMN "stripe_sync_lease_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD CONSTRAINT "scout_profiles_stripe_sync_completed_generation_check" CHECK ("scout_profiles"."stripe_sync_completed_generation" >= 0 AND "scout_profiles"."stripe_sync_completed_generation" <= "scout_profiles"."stripe_sync_generation");
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD CONSTRAINT "scout_profiles_stripe_sync_lease_check" CHECK (("scout_profiles"."stripe_sync_lease_token" IS NULL AND "scout_profiles"."stripe_sync_lease_expires_at" IS NULL) OR ("scout_profiles"."stripe_sync_lease_token" IS NOT NULL AND "scout_profiles"."stripe_sync_lease_expires_at" IS NOT NULL));
