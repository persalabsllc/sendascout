ALTER TABLE "missions" ADD COLUMN "pickup_name" text;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "pickup_instructions" text;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "dropoff_name" text;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "dropoff_address_line_1" text;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "dropoff_address_line_2" text;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "dropoff_city" text;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "dropoff_state" text;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "dropoff_zip" text;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "delivery_instructions" text;