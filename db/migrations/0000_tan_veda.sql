CREATE TYPE "public"."account_status" AS ENUM('pending', 'active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."mission_status" AS ENUM('draft', 'open', 'claimed', 'en_route', 'onsite', 'submitted', 'completed', 'cancelled', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."mission_type" AS ENUM('see', 'move', 'meet');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('unpaid', 'authorized', 'paid', 'refunded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."scout_status" AS ENUM('applicant', 'review', 'approved', 'paused', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('customer', 'scout', 'admin');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('not_started', 'pending', 'clear', 'review', 'failed');--> statement-breakpoint
CREATE TABLE "mission_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"author_id" uuid,
	"status" "mission_status",
	"message" text,
	"media_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "missions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"scout_id" uuid,
	"type" "mission_type" NOT NULL,
	"status" "mission_status" DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"instructions" text NOT NULL,
	"address_line_1" text NOT NULL,
	"address_line_2" text,
	"city" text NOT NULL,
	"state" text DEFAULT 'NC' NOT NULL,
	"zip" text NOT NULL,
	"scheduled_for" timestamp with time zone,
	"customer_price_cents" integer NOT NULL,
	"scout_payout_cents" integer NOT NULL,
	"platform_fee_cents" integer NOT NULL,
	"payment_status" "payment_status" DEFAULT 'unpaid' NOT NULL,
	"stripe_payment_intent_id" text,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"stripe_payment_intent_id" text NOT NULL,
	"stripe_transfer_id" text,
	"amount_cents" integer NOT NULL,
	"scout_payout_cents" integer NOT NULL,
	"platform_fee_cents" integer NOT NULL,
	"status" "payment_status" DEFAULT 'unpaid' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scout_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "scout_status" DEFAULT 'applicant' NOT NULL,
	"background_check" "verification_status" DEFAULT 'not_started' NOT NULL,
	"identity_check" "verification_status" DEFAULT 'not_started' NOT NULL,
	"home_zip" text,
	"service_radius_miles" integer DEFAULT 25 NOT NULL,
	"vehicle_type" text,
	"can_see" boolean DEFAULT true NOT NULL,
	"can_move" boolean DEFAULT true NOT NULL,
	"can_meet" boolean DEFAULT true NOT NULL,
	"stripe_account_id" text,
	"payouts_enabled" boolean DEFAULT false NOT NULL,
	"rating" numeric(3, 2),
	"completed_missions" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_user_id" text NOT NULL,
	"role" "user_role" DEFAULT 'customer' NOT NULL,
	"status" "account_status" DEFAULT 'active' NOT NULL,
	"first_name" text,
	"last_name" text,
	"email" text NOT NULL,
	"phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mission_updates" ADD CONSTRAINT "mission_updates_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_updates" ADD CONSTRAINT "mission_updates_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_scout_id_users_id_fk" FOREIGN KEY ("scout_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD CONSTRAINT "scout_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mission_updates_mission_idx" ON "mission_updates" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "missions_status_idx" ON "missions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "missions_customer_idx" ON "missions" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "missions_scout_idx" ON "missions" USING btree ("scout_id");--> statement-breakpoint
CREATE INDEX "missions_zip_idx" ON "missions" USING btree ("zip");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_payment_intent_idx" ON "payments" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
CREATE INDEX "payments_mission_idx" ON "payments" USING btree ("mission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scout_profiles_user_id_idx" ON "scout_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_clerk_user_id_idx" ON "users" USING btree ("clerk_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");