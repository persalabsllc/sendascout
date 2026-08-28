CREATE TYPE "public"."notification_channel" AS ENUM('in_app', 'sms', 'email');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
ALTER TYPE "public"."mission_status" ADD VALUE 'en_route_pickup' BEFORE 'submitted';--> statement-breakpoint
ALTER TYPE "public"."mission_status" ADD VALUE 'at_pickup' BEFORE 'submitted';--> statement-breakpoint
ALTER TYPE "public"."mission_status" ADD VALUE 'en_route_dropoff' BEFORE 'submitted';--> statement-breakpoint
ALTER TYPE "public"."mission_status" ADD VALUE 'at_dropoff' BEFORE 'submitted';--> statement-breakpoint
CREATE TABLE "mission_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"mission_id" uuid,
	"channel" "notification_channel" DEFAULT 'in_app' NOT NULL,
	"status" "notification_status" DEFAULT 'pending' NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"provider_message_id" text,
	"error" text,
	"read_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "location_sharing_active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "scout_latitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "scout_longitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "scout_location_accuracy_meters" integer;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "scout_location_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mission_messages" ADD CONSTRAINT "mission_messages_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_messages" ADD CONSTRAINT "mission_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mission_messages_mission_idx" ON "mission_messages" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "mission_messages_sender_idx" ON "mission_messages" USING btree ("sender_id");--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "notifications" USING btree ("recipient_user_id");--> statement-breakpoint
CREATE INDEX "notifications_mission_idx" ON "notifications" USING btree ("mission_id");