ALTER TABLE "users" ADD COLUMN "address_line_1" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "address_line_2" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "zip" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "profile_completed_at" timestamp with time zone;