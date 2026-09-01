ALTER TABLE "scout_profiles" ADD COLUMN "handbook_version" text;
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD COLUMN "handbook_accepted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "scout_profiles" ADD CONSTRAINT "scout_profiles_handbook_acceptance_check" CHECK (("handbook_version" IS NULL AND "handbook_accepted_at" IS NULL) OR ("handbook_version" IS NOT NULL AND "handbook_accepted_at" IS NOT NULL));
--> statement-breakpoint
CREATE TABLE "scout_handbook_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"handbook_version" text NOT NULL,
	"source" text NOT NULL,
	"user_agent" text,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scout_handbook_acceptances_source_check" CHECK ("source" IN ('onboarding', 'dashboard'))
);
--> statement-breakpoint
ALTER TABLE "scout_handbook_acceptances" ADD CONSTRAINT "scout_handbook_acceptances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "scout_handbook_acceptances_user_version_idx" ON "scout_handbook_acceptances" USING btree ("user_id","handbook_version");
--> statement-breakpoint
CREATE INDEX "scout_handbook_acceptances_user_idx" ON "scout_handbook_acceptances" USING btree ("user_id");
