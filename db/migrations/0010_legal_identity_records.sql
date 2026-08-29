CREATE TABLE "legal_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "user_role" NOT NULL,
	"legal_version" text NOT NULL,
	"terms_version" text NOT NULL,
	"privacy_version" text NOT NULL,
	"policies_version" text NOT NULL,
	"arbitration_accepted" boolean NOT NULL,
	"electronic_records_accepted" boolean NOT NULL,
	"source" text DEFAULT 'web' NOT NULL,
	"user_agent" text,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD COLUMN "identity_provider" text;--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD COLUMN "identity_verification_reference" text;--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD COLUMN "identity_verified_name" text;--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD COLUMN "identity_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD COLUMN "identity_verified_by" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "legal_version" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "legal_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "legal_acceptances_user_version_idx" ON "legal_acceptances" USING btree ("user_id","legal_version");--> statement-breakpoint
CREATE INDEX "legal_acceptances_user_idx" ON "legal_acceptances" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD CONSTRAINT "scout_profiles_identity_verified_by_users_id_fk" FOREIGN KEY ("identity_verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;