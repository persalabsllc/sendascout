ALTER TABLE "missions" ADD COLUMN "pickup_latitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "pickup_longitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "dropoff_latitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "dropoff_longitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "route_distance_meters" integer;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "route_duration_seconds" integer;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "route_source" text DEFAULT 'fixed' NOT NULL;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "route_quoted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "meet_authorized_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "maximum_customer_price_cents" integer;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "maximum_scout_payout_cents" integer;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "billable_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "billable_ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "billable_last_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "billable_minutes" integer;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "charged_minutes" integer;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "verified_check_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "verified_check_in_latitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "verified_check_in_longitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "verified_check_in_accuracy_meters" integer;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "verified_check_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "verified_check_out_latitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "verified_check_out_longitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "verified_check_out_accuracy_meters" integer;