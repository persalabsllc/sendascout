ALTER TABLE "customer_saved_locations" ALTER COLUMN "state" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "missions" ALTER COLUMN "state" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "timezone" text DEFAULT 'America/New_York' NOT NULL;
--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_timezone_check" CHECK ("timezone" IN ('America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'));
