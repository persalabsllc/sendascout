ALTER TABLE "scout_profiles" ADD COLUMN "headshot_upload_window_started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD COLUMN "headshot_upload_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD CONSTRAINT "scout_profiles_headshot_upload_count_check" CHECK ("scout_profiles"."headshot_upload_count" >= 0);
--> statement-breakpoint
CREATE TABLE "business_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"billing_email" text,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_accounts_status_check" CHECK ("business_accounts"."status" IN ('active', 'paused', 'closed'))
);
--> statement-breakpoint
ALTER TABLE "business_accounts" ADD CONSTRAINT "business_accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "business_accounts_owner_idx" ON "business_accounts" USING btree ("owner_user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "business_accounts_stripe_customer_idx" ON "business_accounts" USING btree ("stripe_customer_id");
--> statement-breakpoint
CREATE TABLE "business_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'requester' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_members_role_check" CHECK ("business_members"."role" IN ('owner', 'admin', 'requester', 'viewer'))
);
--> statement-breakpoint
ALTER TABLE "business_members" ADD CONSTRAINT "business_members_business_account_id_fk" FOREIGN KEY ("business_account_id") REFERENCES "public"."business_accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "business_members" ADD CONSTRAINT "business_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "business_members_account_user_idx" ON "business_members" USING btree ("business_account_id", "user_id");
--> statement-breakpoint
CREATE INDEX "business_members_user_idx" ON "business_members" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE "customer_saved_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"business_account_id" uuid,
	"label" text NOT NULL,
	"address_line_1" text NOT NULL,
	"address_line_2" text,
	"city" text NOT NULL,
	"state" text DEFAULT 'NC' NOT NULL,
	"zip" text NOT NULL,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_saved_locations" ADD CONSTRAINT "customer_saved_locations_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_saved_locations" ADD CONSTRAINT "customer_saved_locations_business_account_id_fk" FOREIGN KEY ("business_account_id") REFERENCES "public"."business_accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "customer_saved_locations_customer_idx" ON "customer_saved_locations" USING btree ("customer_id");
--> statement-breakpoint
CREATE INDEX "customer_saved_locations_business_idx" ON "customer_saved_locations" USING btree ("business_account_id");
--> statement-breakpoint
CREATE TABLE "mission_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"business_account_id" uuid,
	"name" text NOT NULL,
	"type" "mission_type" NOT NULL,
	"configuration_json" jsonb NOT NULL,
	"preferred_scout_id" uuid,
	"last_used_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mission_templates" ADD CONSTRAINT "mission_templates_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_templates" ADD CONSTRAINT "mission_templates_business_account_id_fk" FOREIGN KEY ("business_account_id") REFERENCES "public"."business_accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_templates" ADD CONSTRAINT "mission_templates_preferred_scout_id_fk" FOREIGN KEY ("preferred_scout_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "mission_templates_customer_idx" ON "mission_templates" USING btree ("customer_id");
--> statement-breakpoint
CREATE INDEX "mission_templates_business_idx" ON "mission_templates" USING btree ("business_account_id");
--> statement-breakpoint
CREATE TABLE "mission_recurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"business_account_id" uuid,
	"template_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"recurrence_rule" text NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"preferred_scout_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mission_recurrences_status_check" CHECK ("mission_recurrences"."status" IN ('active', 'paused', 'ended'))
);
--> statement-breakpoint
ALTER TABLE "mission_recurrences" ADD CONSTRAINT "mission_recurrences_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_recurrences" ADD CONSTRAINT "mission_recurrences_business_account_id_fk" FOREIGN KEY ("business_account_id") REFERENCES "public"."business_accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_recurrences" ADD CONSTRAINT "mission_recurrences_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."mission_templates"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_recurrences" ADD CONSTRAINT "mission_recurrences_preferred_scout_id_fk" FOREIGN KEY ("preferred_scout_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "mission_recurrences_due_idx" ON "mission_recurrences" USING btree ("status", "next_run_at");
--> statement-breakpoint
CREATE INDEX "mission_recurrences_customer_idx" ON "mission_recurrences" USING btree ("customer_id");
--> statement-breakpoint
CREATE TABLE "mission_bundles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"business_account_id" uuid,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"active_sequence" integer DEFAULT 1 NOT NULL,
	"list_customer_price_cents" integer DEFAULT 0 NOT NULL,
	"bundle_discount_cents" integer DEFAULT 0 NOT NULL,
	"customer_price_cents" integer DEFAULT 0 NOT NULL,
	"scout_payout_cents" integer DEFAULT 0 NOT NULL,
	"platform_fee_cents" integer DEFAULT 0 NOT NULL,
	"payment_status" "payment_status" DEFAULT 'unpaid' NOT NULL,
	"stripe_payment_intent_id" text,
	"submitted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mission_bundles_status_check" CHECK ("mission_bundles"."status" IN ('draft', 'open', 'claimed', 'in_progress', 'submitted', 'completed', 'cancelled', 'disputed')),
	CONSTRAINT "mission_bundles_active_sequence_check" CHECK ("mission_bundles"."active_sequence" > 0),
	CONSTRAINT "mission_bundles_amounts_check" CHECK ("mission_bundles"."list_customer_price_cents" >= 0 AND "mission_bundles"."bundle_discount_cents" >= 0 AND "mission_bundles"."customer_price_cents" >= 0 AND "mission_bundles"."scout_payout_cents" >= 0 AND "mission_bundles"."platform_fee_cents" >= 0 AND "mission_bundles"."bundle_discount_cents" <= "mission_bundles"."list_customer_price_cents" AND "mission_bundles"."customer_price_cents" = "mission_bundles"."list_customer_price_cents" - "mission_bundles"."bundle_discount_cents" AND "mission_bundles"."platform_fee_cents" = "mission_bundles"."customer_price_cents" - "mission_bundles"."scout_payout_cents")
);
--> statement-breakpoint
ALTER TABLE "mission_bundles" ADD CONSTRAINT "mission_bundles_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_bundles" ADD CONSTRAINT "mission_bundles_business_account_id_fk" FOREIGN KEY ("business_account_id") REFERENCES "public"."business_accounts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "mission_bundles_customer_idx" ON "mission_bundles" USING btree ("customer_id");
--> statement-breakpoint
CREATE INDEX "mission_bundles_business_idx" ON "mission_bundles" USING btree ("business_account_id");
--> statement-breakpoint
CREATE INDEX "mission_bundles_status_idx" ON "mission_bundles" USING btree ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX "mission_bundles_payment_intent_idx" ON "mission_bundles" USING btree ("stripe_payment_intent_id");
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "bundle_id" uuid;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "bundle_sequence" integer;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "predecessor_mission_id" uuid;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "source_mission_id" uuid;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "template_id" uuid;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "recurrence_id" uuid;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "recurrence_occurrence_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "preferred_scout_id" uuid;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "preferred_scout_exclusive_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "preferred_scout_broadcast_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "scout_display_name_snapshot" text;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "scout_headshot_path_snapshot" text;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "scout_identity_verified_at_snapshot" timestamp with time zone;
--> statement-breakpoint
UPDATE "missions" AS mission
SET "scout_display_name_snapshot" = COALESCE(
	mission."scout_display_name_snapshot",
	NULLIF(TRIM(COALESCE(profile."identity_verified_name", CONCAT_WS(' ', scout_user."first_name", scout_user."last_name"))), '')
),
"scout_headshot_path_snapshot" = COALESCE(mission."scout_headshot_path_snapshot", profile."headshot_path"),
"scout_identity_verified_at_snapshot" = COALESCE(
	mission."scout_identity_verified_at_snapshot",
	CASE WHEN profile."identity_check" = 'clear' THEN profile."identity_verified_at" ELSE NULL END
)
FROM "scout_profiles" AS profile
INNER JOIN "users" AS scout_user ON scout_user."id" = profile."user_id"
WHERE mission."scout_id" = profile."user_id";
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "delivery_pin_required" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "delivery_pin_hash" text;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "delivery_pin_hint" text;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "delivery_pin_failed_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "delivery_pin_locked_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "delivery_pin_verified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "delivery_pin_verified_by" uuid;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "proof_of_delivery_required" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "enhanced_report_requested" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "result_upload_token_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "list_customer_price_cents" integer;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "bundle_discount_cents" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_bundle_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."mission_bundles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_predecessor_mission_id_fk" FOREIGN KEY ("predecessor_mission_id") REFERENCES "public"."missions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_source_mission_id_fk" FOREIGN KEY ("source_mission_id") REFERENCES "public"."missions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."mission_templates"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_recurrence_id_fk" FOREIGN KEY ("recurrence_id") REFERENCES "public"."mission_recurrences"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_preferred_scout_id_fk" FOREIGN KEY ("preferred_scout_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_delivery_pin_verified_by_fk" FOREIGN KEY ("delivery_pin_verified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_bundle_pair_check" CHECK (("missions"."bundle_id" IS NULL AND "missions"."bundle_sequence" IS NULL) OR ("missions"."bundle_id" IS NOT NULL AND "missions"."bundle_sequence" IS NOT NULL AND "missions"."bundle_sequence" > 0));
--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_delivery_pin_check" CHECK (NOT "missions"."delivery_pin_required" OR ("missions"."type" = 'move' AND "missions"."delivery_pin_hash" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_delivery_pin_attempts_check" CHECK ("missions"."delivery_pin_failed_attempts" >= 0);
--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_result_upload_token_count_check" CHECK ("missions"."result_upload_token_count" >= 0 AND "missions"."result_upload_token_count" <= 30);
--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_proof_delivery_check" CHECK (NOT "missions"."proof_of_delivery_required" OR "missions"."type" = 'move');
--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_financial_amounts_check" CHECK ("missions"."customer_price_cents" >= 0 AND "missions"."scout_payout_cents" >= 0 AND "missions"."platform_fee_cents" >= 0 AND "missions"."customer_price_cents" = "missions"."scout_payout_cents" + "missions"."platform_fee_cents");
--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_feature_pricing_check" CHECK ("missions"."bundle_discount_cents" >= 0 AND ("missions"."list_customer_price_cents" IS NULL OR ("missions"."list_customer_price_cents" >= 0 AND "missions"."bundle_discount_cents" <= "missions"."list_customer_price_cents")));
--> statement-breakpoint
CREATE INDEX "missions_bundle_idx" ON "missions" USING btree ("bundle_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "missions_bundle_sequence_idx" ON "missions" USING btree ("bundle_id", "bundle_sequence");
--> statement-breakpoint
CREATE INDEX "missions_predecessor_idx" ON "missions" USING btree ("predecessor_mission_id");
--> statement-breakpoint
CREATE INDEX "missions_template_idx" ON "missions" USING btree ("template_id");
--> statement-breakpoint
CREATE INDEX "missions_recurrence_idx" ON "missions" USING btree ("recurrence_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "missions_recurrence_occurrence_idx" ON "missions" USING btree ("recurrence_id", "recurrence_occurrence_at");
--> statement-breakpoint
CREATE INDEX "missions_preferred_scout_idx" ON "missions" USING btree ("preferred_scout_id", "preferred_scout_exclusive_until");
--> statement-breakpoint
ALTER TABLE "mission_updates" ADD COLUMN "evidence_kind" text;
--> statement-breakpoint
CREATE TABLE "customer_preferred_scouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"scout_id" uuid NOT NULL,
	"source_mission_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_preferred_scouts_distinct_users_check" CHECK ("customer_preferred_scouts"."customer_id" <> "customer_preferred_scouts"."scout_id")
);
--> statement-breakpoint
ALTER TABLE "customer_preferred_scouts" ADD CONSTRAINT "customer_preferred_scouts_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_preferred_scouts" ADD CONSTRAINT "customer_preferred_scouts_scout_id_fk" FOREIGN KEY ("scout_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_preferred_scouts" ADD CONSTRAINT "customer_preferred_scouts_source_mission_id_fk" FOREIGN KEY ("source_mission_id") REFERENCES "public"."missions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "customer_preferred_scouts_pair_idx" ON "customer_preferred_scouts" USING btree ("customer_id", "scout_id");
--> statement-breakpoint
CREATE INDEX "customer_preferred_scouts_scout_idx" ON "customer_preferred_scouts" USING btree ("scout_id");
--> statement-breakpoint
CREATE TABLE "mission_change_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"proposed_by_user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"description" text NOT NULL,
	"customer_delta_cents" integer DEFAULT 0 NOT NULL,
	"scout_delta_cents" integer DEFAULT 0 NOT NULL,
	"platform_delta_cents" integer DEFAULT 0 NOT NULL,
	"linked_mission_id" uuid,
	"expires_at" timestamp with time zone,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"fulfilled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mission_change_orders_status_check" CHECK ("mission_change_orders"."status" IN ('pending', 'approved', 'declined', 'expired', 'fulfilled', 'cancelled')),
	CONSTRAINT "mission_change_orders_amounts_check" CHECK ("mission_change_orders"."customer_delta_cents" >= 0 AND "mission_change_orders"."scout_delta_cents" >= 0 AND "mission_change_orders"."platform_delta_cents" >= 0 AND "mission_change_orders"."customer_delta_cents" = "mission_change_orders"."scout_delta_cents" + "mission_change_orders"."platform_delta_cents")
);
--> statement-breakpoint
ALTER TABLE "mission_change_orders" ADD CONSTRAINT "mission_change_orders_mission_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_change_orders" ADD CONSTRAINT "mission_change_orders_proposed_by_user_id_fk" FOREIGN KEY ("proposed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_change_orders" ADD CONSTRAINT "mission_change_orders_linked_mission_id_fk" FOREIGN KEY ("linked_mission_id") REFERENCES "public"."missions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_change_orders" ADD CONSTRAINT "mission_change_orders_approved_by_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "mission_change_orders_mission_idx" ON "mission_change_orders" USING btree ("mission_id");
--> statement-breakpoint
CREATE INDEX "mission_change_orders_status_idx" ON "mission_change_orders" USING btree ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX "mission_change_orders_one_pending_idx" ON "mission_change_orders" USING btree ("mission_id") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION cancel_pending_mission_change_orders_on_close()
RETURNS trigger AS $$
BEGIN
	IF NEW.status IN ('submitted', 'completed', 'cancelled') AND OLD.status IS DISTINCT FROM NEW.status THEN
		UPDATE mission_change_orders
		SET status = 'cancelled', updated_at = NEW.updated_at
		WHERE mission_id = NEW.id AND status = 'pending';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER missions_cancel_pending_change_orders_on_close
AFTER UPDATE OF status ON missions
FOR EACH ROW
EXECUTE FUNCTION cancel_pending_mission_change_orders_on_close();
--> statement-breakpoint
CREATE TABLE "mission_part_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"summary" text,
	"submitted_by_user_id" uuid,
	"submitted_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mission_part_results_status_check" CHECK ("mission_part_results"."status" IN ('draft', 'submitted', 'accepted', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "mission_part_results" ADD CONSTRAINT "mission_part_results_mission_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_part_results" ADD CONSTRAINT "mission_part_results_submitted_by_user_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "mission_part_results_mission_idx" ON "mission_part_results" USING btree ("mission_id");
--> statement-breakpoint
CREATE TABLE "mission_checklist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"prompt" text NOT NULL,
	"response_type" text DEFAULT 'check' NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"response_text" text,
	"completed_by_user_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mission_checklist_items_sequence_check" CHECK ("mission_checklist_items"."sequence" > 0),
	CONSTRAINT "mission_checklist_items_response_type_check" CHECK ("mission_checklist_items"."response_type" IN ('check', 'text', 'photo', 'video', 'number'))
);
--> statement-breakpoint
ALTER TABLE "mission_checklist_items" ADD CONSTRAINT "mission_checklist_items_mission_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_checklist_items" ADD CONSTRAINT "mission_checklist_items_completed_by_user_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "mission_checklist_items_sequence_idx" ON "mission_checklist_items" USING btree ("mission_id", "sequence");
--> statement-breakpoint
CREATE TABLE "mission_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"mission_update_id" uuid,
	"checklist_item_id" uuid,
	"uploaded_by_user_id" uuid,
	"kind" text DEFAULT 'general_result' NOT NULL,
	"storage_path" text NOT NULL,
	"content_type" text,
	"byte_size" integer,
	"caption" text,
	"captured_at" timestamp with time zone,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"customer_visible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mission_evidence_kind_check" CHECK ("mission_evidence"."kind" IN ('general_result', 'delivery_photo', 'checklist_photo', 'checklist_video', 'signature')),
	CONSTRAINT "mission_evidence_byte_size_check" CHECK ("mission_evidence"."byte_size" IS NULL OR "mission_evidence"."byte_size" >= 0)
);
--> statement-breakpoint
ALTER TABLE "mission_evidence" ADD CONSTRAINT "mission_evidence_mission_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_evidence" ADD CONSTRAINT "mission_evidence_mission_update_id_fk" FOREIGN KEY ("mission_update_id") REFERENCES "public"."mission_updates"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_evidence" ADD CONSTRAINT "mission_evidence_checklist_item_id_fk" FOREIGN KEY ("checklist_item_id") REFERENCES "public"."mission_checklist_items"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_evidence" ADD CONSTRAINT "mission_evidence_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "mission_evidence_storage_path_idx" ON "mission_evidence" USING btree ("storage_path");
--> statement-breakpoint
CREATE INDEX "mission_evidence_mission_kind_idx" ON "mission_evidence" USING btree ("mission_id", "kind");
--> statement-breakpoint
CREATE INDEX "mission_evidence_checklist_idx" ON "mission_evidence" USING btree ("checklist_item_id");
