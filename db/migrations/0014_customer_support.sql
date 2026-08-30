CREATE TABLE "customer_support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"mission_id" uuid,
	"reason" text NOT NULL,
	"summary" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution_type" text,
	"resolution_amount_cents" integer DEFAULT 0 NOT NULL,
	"resolution_note" text,
	"proposed_by" uuid,
	"proposed_at" timestamp with time zone,
	"customer_decision" text,
	"customer_decision_note" text,
	"decided_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_support_tickets_reason_check" CHECK ("reason" IN ('mission_not_completed', 'mission_quality', 'scout_conduct', 'delivery_problem', 'billing_question', 'account_technical', 'other')),
	CONSTRAINT "customer_support_tickets_status_check" CHECK ("status" IN ('open', 'awaiting_customer', 'closed')),
	CONSTRAINT "customer_support_tickets_resolution_check" CHECK ("resolution_type" IS NULL OR "resolution_type" IN ('full_refund', 'partial_refund', 'account_credit')),
	CONSTRAINT "customer_support_tickets_decision_check" CHECK ("customer_decision" IS NULL OR "customer_decision" IN ('approved', 'needs_review')),
	CONSTRAINT "customer_support_tickets_amount_check" CHECK ("resolution_amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "customer_support_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"author_role" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_support_messages_role_check" CHECK ("author_role" IN ('customer', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "customer_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"remaining_amount_cents" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_credits_amount_check" CHECK ("amount_cents" > 0 AND "remaining_amount_cents" >= 0 AND "remaining_amount_cents" <= "amount_cents"),
	CONSTRAINT "customer_credits_status_check" CHECK ("status" IN ('active', 'used', 'void'))
);
--> statement-breakpoint
ALTER TABLE "customer_support_tickets" ADD CONSTRAINT "customer_support_tickets_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_support_tickets" ADD CONSTRAINT "customer_support_tickets_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_support_tickets" ADD CONSTRAINT "customer_support_tickets_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_support_messages" ADD CONSTRAINT "customer_support_messages_ticket_id_customer_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."customer_support_tickets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_support_messages" ADD CONSTRAINT "customer_support_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_credits" ADD CONSTRAINT "customer_credits_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_credits" ADD CONSTRAINT "customer_credits_ticket_id_customer_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."customer_support_tickets"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "customer_support_tickets_customer_idx" ON "customer_support_tickets" USING btree ("customer_id");
--> statement-breakpoint
CREATE INDEX "customer_support_tickets_mission_idx" ON "customer_support_tickets" USING btree ("mission_id");
--> statement-breakpoint
CREATE INDEX "customer_support_tickets_status_idx" ON "customer_support_tickets" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "customer_support_messages_ticket_idx" ON "customer_support_messages" USING btree ("ticket_id");
--> statement-breakpoint
CREATE INDEX "customer_credits_customer_idx" ON "customer_credits" USING btree ("customer_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "customer_credits_ticket_idx" ON "customer_credits" USING btree ("ticket_id");
