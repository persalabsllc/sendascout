ALTER TYPE "payment_status" ADD VALUE IF NOT EXISTS 'processing' AFTER 'unpaid';
--> statement-breakpoint
ALTER TYPE "payment_status" ADD VALUE IF NOT EXISTS 'requires_action' AFTER 'unpaid';
--> statement-breakpoint
ALTER TYPE "payment_status" ADD VALUE IF NOT EXISTS 'pending' AFTER 'unpaid';
--> statement-breakpoint
ALTER TYPE "payment_status" ADD VALUE IF NOT EXISTS 'partially_refunded' AFTER 'paid';
--> statement-breakpoint
ALTER TYPE "payment_status" ADD VALUE IF NOT EXISTS 'disputed' AFTER 'failed';
--> statement-breakpoint
ALTER TYPE "payment_status" ADD VALUE IF NOT EXISTS 'cancelled' AFTER 'failed';
--> statement-breakpoint
CREATE TYPE "public"."payment_transaction_status" AS ENUM('pending', 'requires_action', 'processing', 'authorized', 'paid', 'partially_refunded', 'refunded', 'failed', 'canceled', 'disputed');
--> statement-breakpoint
CREATE TYPE "public"."payout_transfer_status" AS ENUM('pending', 'processing', 'succeeded', 'partially_reversed', 'reversed', 'failed');
--> statement-breakpoint
CREATE TYPE "public"."stripe_payout_status" AS ENUM('pending', 'in_transit', 'paid', 'failed', 'canceled');
--> statement-breakpoint
CREATE TYPE "public"."stripe_refund_status" AS ENUM('pending', 'requires_action', 'succeeded', 'failed', 'canceled');
--> statement-breakpoint
CREATE TYPE "public"."stripe_webhook_status" AS ENUM('received', 'processing', 'processed', 'failed', 'ignored');
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "stripe_customer_id" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "stripe_customer_livemode" boolean;
--> statement-breakpoint
CREATE UNIQUE INDEX "users_stripe_customer_idx" ON "users" USING btree ("stripe_customer_id");
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD COLUMN "stripe_account_api_version" text;
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD COLUMN "stripe_account_livemode" boolean;
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD COLUMN "stripe_connect_status" text DEFAULT 'not_started' NOT NULL;
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD COLUMN "stripe_details_submitted" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD COLUMN "stripe_transfers_active" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD COLUMN "stripe_requirements_currently_due" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD COLUMN "stripe_requirements_past_due" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD COLUMN "stripe_requirements_pending_verification" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD COLUMN "stripe_requirements_future_due" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD COLUMN "stripe_disabled_reason" text;
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD COLUMN "stripe_connect_synced_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD COLUMN "stripe_onboarding_completed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD COLUMN "stripe_payout_schedule_configured_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX "scout_profiles_stripe_account_idx" ON "scout_profiles" USING btree ("stripe_account_id");
--> statement-breakpoint
UPDATE "scout_profiles"
SET "stripe_account_api_version" = 'v1',
    "stripe_connect_status" = 'pending',
    "stripe_connect_synced_at" = NULL
WHERE "stripe_account_id" IS NOT NULL
  AND "stripe_account_api_version" IS NULL;
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD CONSTRAINT "scout_profiles_stripe_api_version_check" CHECK ("stripe_account_api_version" IS NULL OR "stripe_account_api_version" IN ('v1', 'v2'));
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD CONSTRAINT "scout_profiles_stripe_identity_check" CHECK (("stripe_account_id" IS NULL AND "stripe_account_api_version" IS NULL) OR ("stripe_account_id" IS NOT NULL AND "stripe_account_api_version" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD CONSTRAINT "scout_profiles_stripe_status_check" CHECK ("stripe_connect_status" IN ('not_started', 'onboarding', 'pending', 'ready', 'restricted', 'disabled'));
--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "stripe_payment_intent_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "bundle_id" uuid;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "customer_id" uuid;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "mission_change_order_id" uuid;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "mission_review_id" uuid;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "kind" text DEFAULT 'booking' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "currency" text DEFAULT 'usd' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "stripe_customer_id" text;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "livemode" boolean;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "stripe_checkout_session_id" text;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "stripe_charge_id" text;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "stripe_balance_transaction_id" text;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "stripe_fee_cents" integer;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "stripe_net_cents" integer;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "stripe_transfer_group" text;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "idempotency_key" text;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "refunded_amount_cents" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "status" TYPE "payment_transaction_status" USING (
  CASE WHEN "status"::text = 'unpaid' THEN 'pending' ELSE "status"::text END
)::"payment_transaction_status";
--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "status" SET DEFAULT 'pending'::"payment_transaction_status";
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "failure_code" text;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "failure_message" text;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "paid_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "failed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "cancelled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "disputed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "customer_support_tickets" ADD COLUMN "financial_approved_by" uuid;
--> statement-breakpoint
ALTER TABLE "customer_support_tickets" ADD COLUMN "financial_approved_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "payments" AS payment
SET "customer_id" = mission."customer_id",
    "bundle_id" = mission."bundle_id",
    "stripe_customer_id" = customer."stripe_customer_id",
    "stripe_transfer_group" = CASE
      WHEN mission."bundle_id" IS NULL THEN 'mission_' || mission."id"::text
      ELSE 'bundle_' || mission."bundle_id"::text
    END,
    "idempotency_key" = 'legacy_payment_' || payment."id"::text,
    "refunded_amount_cents" = CASE
      WHEN payment."status" = 'refunded'::"payment_transaction_status" THEN payment."amount_cents"
      ELSE 0
    END,
    "paid_at" = CASE
      WHEN payment."status" IN ('paid'::"payment_transaction_status", 'refunded'::"payment_transaction_status")
        THEN payment."created_at"
      ELSE NULL
    END
FROM "missions" AS mission
INNER JOIN "users" AS customer ON customer."id" = mission."customer_id"
WHERE mission."id" = payment."mission_id";
--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "customer_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "stripe_transfer_group" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "idempotency_key" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "payments" RENAME COLUMN "stripe_transfer_id" TO "legacy_stripe_transfer_id";
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_bundle_id_mission_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."mission_bundles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_mission_change_order_id_mission_change_orders_id_fk" FOREIGN KEY ("mission_change_order_id") REFERENCES "public"."mission_change_orders"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_mission_review_id_mission_reviews_id_fk" FOREIGN KEY ("mission_review_id") REFERENCES "public"."mission_reviews"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "payments_checkout_session_idx" ON "payments" USING btree ("stripe_checkout_session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payments_charge_idx" ON "payments" USING btree ("stripe_charge_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payments_idempotency_idx" ON "payments" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "payments_booking_mission_idx" ON "payments" USING btree ("mission_id") WHERE "kind" = 'booking';
--> statement-breakpoint
CREATE UNIQUE INDEX "payments_booking_bundle_idx" ON "payments" USING btree ("bundle_id") WHERE "kind" = 'booking' AND "bundle_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "payments_meet_adjustment_idx" ON "payments" USING btree ("mission_id") WHERE "kind" = 'meet_adjustment';
--> statement-breakpoint
CREATE UNIQUE INDEX "payments_change_order_idx" ON "payments" USING btree ("mission_change_order_id") WHERE "mission_change_order_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "payments_review_idx" ON "payments" USING btree ("mission_review_id") WHERE "mission_review_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "payments_bundle_idx" ON "payments" USING btree ("bundle_id");
--> statement-breakpoint
CREATE INDEX "payments_customer_idx" ON "payments" USING btree ("customer_id");
--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status", "updated_at");
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_kind_check" CHECK ("kind" IN ('booking', 'meet_adjustment', 'change_order', 'tip', 'manual', 'duplicate'));
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_kind_scope_check" CHECK (("kind" = 'change_order' AND "mission_change_order_id" IS NOT NULL AND "mission_review_id" IS NULL) OR ("kind" = 'tip' AND "mission_review_id" IS NOT NULL AND "mission_change_order_id" IS NULL) OR ("kind" IN ('booking', 'meet_adjustment', 'manual', 'duplicate') AND "mission_change_order_id" IS NULL AND "mission_review_id" IS NULL));
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_currency_check" CHECK ("currency" = 'usd');
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_amounts_check" CHECK ("amount_cents" >= 0 AND "scout_payout_cents" >= 0 AND "platform_fee_cents" >= 0 AND "amount_cents" = "scout_payout_cents" + "platform_fee_cents" AND "refunded_amount_cents" >= 0 AND "refunded_amount_cents" <= "amount_cents");
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_bundle_scope_check" CHECK ("bundle_id" IS NULL OR "kind" = 'booking');
--> statement-breakpoint
CREATE TABLE "payment_transfers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "payment_id" uuid NOT NULL,
  "mission_id" uuid NOT NULL,
  "bundle_id" uuid,
  "scout_id" uuid NOT NULL,
  "stripe_account_id" text NOT NULL,
  "kind" text DEFAULT 'mission' NOT NULL,
  "amount_cents" integer NOT NULL,
  "currency" text DEFAULT 'usd' NOT NULL,
  "source_charge_id" text NOT NULL,
  "stripe_transfer_group" text NOT NULL,
  "stripe_transfer_id" text,
  "idempotency_key" text NOT NULL,
  "status" "payout_transfer_status" DEFAULT 'pending' NOT NULL,
  "reversed_amount_cents" integer DEFAULT 0 NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "failure_code" text,
  "failure_message" text,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "transferred_at" timestamp with time zone,
  "reversed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payment_transfers_kind_check" CHECK ("kind" IN ('mission', 'tip', 'adjustment', 'manual')),
  CONSTRAINT "payment_transfers_amounts_check" CHECK ("amount_cents" > 0 AND "reversed_amount_cents" >= 0 AND "reversed_amount_cents" <= "amount_cents"),
  CONSTRAINT "payment_transfers_currency_check" CHECK ("currency" = 'usd')
);
--> statement-breakpoint
CREATE TABLE "payment_transfer_reversals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "transfer_id" uuid NOT NULL,
  "amount_cents" integer NOT NULL,
  "stripe_reversal_id" text,
  "idempotency_key" text NOT NULL,
  "status" "stripe_refund_status" DEFAULT 'pending' NOT NULL,
  "failure_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payment_transfer_reversals_amount_check" CHECK ("amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_refunds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "payment_id" uuid NOT NULL,
  "mission_case_id" uuid,
  "amount_cents" integer NOT NULL,
  "currency" text DEFAULT 'usd' NOT NULL,
  "reason" text DEFAULT 'requested_by_customer' NOT NULL,
  "stripe_refund_id" text,
  "idempotency_key" text NOT NULL,
  "status" "stripe_refund_status" DEFAULT 'pending' NOT NULL,
  "failure_code" text,
  "failure_message" text,
  "refunded_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payment_refunds_amount_check" CHECK ("amount_cents" > 0),
  CONSTRAINT "payment_refunds_currency_check" CHECK ("currency" = 'usd')
);
--> statement-breakpoint
CREATE TABLE "payment_disputes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "payment_id" uuid NOT NULL,
  "stripe_dispute_id" text NOT NULL,
  "stripe_charge_id" text NOT NULL,
  "amount_cents" integer NOT NULL,
  "currency" text DEFAULT 'usd' NOT NULL,
  "status" text NOT NULL,
  "reason" text,
  "evidence_due_at" timestamp with time zone,
  "provider_event_created_at" timestamp with time zone NOT NULL,
  "opened_at" timestamp with time zone DEFAULT now() NOT NULL,
  "closed_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payment_disputes_amount_check" CHECK ("amount_cents" > 0),
  CONSTRAINT "payment_disputes_currency_check" CHECK ("currency" = 'usd')
);
--> statement-breakpoint
CREATE TABLE "stripe_payouts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "scout_profile_id" uuid NOT NULL,
  "stripe_account_id" text NOT NULL,
  "stripe_payout_id" text NOT NULL,
  "amount_cents" integer NOT NULL,
  "currency" text DEFAULT 'usd' NOT NULL,
  "method" text DEFAULT 'standard' NOT NULL,
  "automatic" boolean DEFAULT true NOT NULL,
  "status" "stripe_payout_status" DEFAULT 'pending' NOT NULL,
  "arrival_at" timestamp with time zone,
  "failure_code" text,
  "failure_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "stripe_payouts_amount_check" CHECK ("amount_cents" > 0),
  CONSTRAINT "stripe_payouts_currency_check" CHECK ("currency" = 'usd'),
  CONSTRAINT "stripe_payouts_method_check" CHECK ("method" IN ('standard', 'instant'))
);
--> statement-breakpoint
CREATE TABLE "stripe_webhook_events" (
  "event_id" text PRIMARY KEY NOT NULL,
  "type" text NOT NULL,
  "scope" text DEFAULT 'platform' NOT NULL,
  "connected_account_id" text,
  "object_id" text,
  "livemode" boolean NOT NULL,
  "api_version" text,
  "status" "stripe_webhook_status" DEFAULT 'received' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "event_created_at" timestamp with time zone,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "processed_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "stripe_webhook_events_scope_check" CHECK ("scope" IN ('platform', 'connected', 'v2'))
);
--> statement-breakpoint
ALTER TABLE "payment_transfers" ADD CONSTRAINT "payment_transfers_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_transfers" ADD CONSTRAINT "payment_transfers_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_transfers" ADD CONSTRAINT "payment_transfers_bundle_id_mission_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."mission_bundles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_transfers" ADD CONSTRAINT "payment_transfers_scout_id_users_id_fk" FOREIGN KEY ("scout_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_transfer_reversals" ADD CONSTRAINT "payment_transfer_reversals_transfer_id_payment_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."payment_transfers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_mission_case_id_mission_cases_id_fk" FOREIGN KEY ("mission_case_id") REFERENCES "public"."mission_cases"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_disputes" ADD CONSTRAINT "payment_disputes_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_support_tickets" ADD CONSTRAINT "customer_support_tickets_financial_approved_by_users_id_fk" FOREIGN KEY ("financial_approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stripe_payouts" ADD CONSTRAINT "stripe_payouts_scout_profile_id_scout_profiles_id_fk" FOREIGN KEY ("scout_profile_id") REFERENCES "public"."scout_profiles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_transfers_stripe_idx" ON "payment_transfers" USING btree ("stripe_transfer_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_transfers_idempotency_idx" ON "payment_transfers" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_transfers_payment_idx" ON "payment_transfers" USING btree ("payment_id");
--> statement-breakpoint
CREATE INDEX "payment_transfers_mission_idx" ON "payment_transfers" USING btree ("mission_id");
--> statement-breakpoint
CREATE INDEX "payment_transfers_source_charge_idx" ON "payment_transfers" USING btree ("source_charge_id");
--> statement-breakpoint
CREATE INDEX "payment_transfers_status_idx" ON "payment_transfers" USING btree ("status", "next_attempt_at");
--> statement-breakpoint
CREATE INDEX "payment_transfers_scout_idx" ON "payment_transfers" USING btree ("scout_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_transfer_reversals_stripe_idx" ON "payment_transfer_reversals" USING btree ("stripe_reversal_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_transfer_reversals_idempotency_idx" ON "payment_transfer_reversals" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "payment_transfer_reversals_transfer_idx" ON "payment_transfer_reversals" USING btree ("transfer_id");
--> statement-breakpoint
CREATE INDEX "payment_transfer_reversals_status_idx" ON "payment_transfer_reversals" USING btree ("status", "updated_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_refunds_stripe_idx" ON "payment_refunds" USING btree ("stripe_refund_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_refunds_idempotency_idx" ON "payment_refunds" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "payment_refunds_payment_idx" ON "payment_refunds" USING btree ("payment_id");
--> statement-breakpoint
CREATE INDEX "payment_refunds_case_idx" ON "payment_refunds" USING btree ("mission_case_id");
--> statement-breakpoint
CREATE INDEX "payment_refunds_status_idx" ON "payment_refunds" USING btree ("status", "updated_at");
--> statement-breakpoint
CREATE INDEX "payment_refunds_reason_idx" ON "payment_refunds" USING btree ("reason");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_disputes_stripe_idx" ON "payment_disputes" USING btree ("stripe_dispute_id");
--> statement-breakpoint
CREATE INDEX "payment_disputes_payment_idx" ON "payment_disputes" USING btree ("payment_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_payouts_stripe_idx" ON "stripe_payouts" USING btree ("stripe_payout_id");
--> statement-breakpoint
CREATE INDEX "stripe_payouts_scout_idx" ON "stripe_payouts" USING btree ("scout_profile_id", "created_at");
--> statement-breakpoint
CREATE INDEX "stripe_webhook_events_status_idx" ON "stripe_webhook_events" USING btree ("status", "updated_at");
--> statement-breakpoint
CREATE INDEX "stripe_webhook_events_object_idx" ON "stripe_webhook_events" USING btree ("object_id");
