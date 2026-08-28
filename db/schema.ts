import {
  boolean,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["customer", "scout", "admin"]);
export const accountStatus = pgEnum("account_status", ["pending", "active", "suspended"]);
export const scoutStatus = pgEnum("scout_status", ["applicant", "review", "approved", "paused", "rejected"]);
export const verificationStatus = pgEnum("verification_status", ["not_started", "pending", "clear", "review", "failed"]);
export const missionType = pgEnum("mission_type", ["see", "move", "meet"]);
export const missionStatus = pgEnum("mission_status", [
  "draft",
  "open",
  "claimed",
  "en_route",
  "onsite",
  "submitted",
  "completed",
  "cancelled",
  "disputed",
]);
export const paymentStatus = pgEnum("payment_status", ["unpaid", "authorized", "paid", "refunded", "failed"]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  clerkUserId: text("clerk_user_id").notNull(),
  role: userRole("role").notNull().default("customer"),
  status: accountStatus("status").notNull().default("active"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  email: text("email").notNull(),
  phone: text("phone"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("users_clerk_user_id_idx").on(table.clerkUserId),
  uniqueIndex("users_email_idx").on(table.email),
]);

export const scoutProfiles = pgTable("scout_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: scoutStatus("status").notNull().default("applicant"),
  backgroundCheck: verificationStatus("background_check").notNull().default("not_started"),
  identityCheck: verificationStatus("identity_check").notNull().default("not_started"),
  homeZip: text("home_zip"),
  serviceRadiusMiles: integer("service_radius_miles").notNull().default(25),
  vehicleType: text("vehicle_type"),
  experience: text("experience"),
  canSee: boolean("can_see").notNull().default(true),
  canMove: boolean("can_move").notNull().default(true),
  canMeet: boolean("can_meet").notNull().default(true),
  stripeAccountId: text("stripe_account_id"),
  payoutsEnabled: boolean("payouts_enabled").notNull().default(false),
  verificationConsentedAt: timestamp("verification_consented_at", { withTimezone: true }),
  rating: numeric("rating", { precision: 3, scale: 2 }),
  completedMissions: integer("completed_missions").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("scout_profiles_user_id_idx").on(table.userId)]);

export const missions = pgTable("missions", {
  id: uuid("id").defaultRandom().primaryKey(),
  customerId: uuid("customer_id").notNull().references(() => users.id),
  scoutId: uuid("scout_id").references(() => users.id),
  type: missionType("type").notNull(),
  status: missionStatus("status").notNull().default("draft"),
  title: text("title").notNull(),
  instructions: text("instructions").notNull(),
  addressLine1: text("address_line_1").notNull(),
  addressLine2: text("address_line_2"),
  city: text("city").notNull(),
  state: text("state").notNull().default("NC"),
  zip: text("zip").notNull(),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  customerPriceCents: integer("customer_price_cents").notNull(),
  scoutPayoutCents: integer("scout_payout_cents").notNull(),
  platformFeeCents: integer("platform_fee_cents").notNull(),
  paymentStatus: paymentStatus("payment_status").notNull().default("unpaid"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("missions_status_idx").on(table.status),
  index("missions_customer_idx").on(table.customerId),
  index("missions_scout_idx").on(table.scoutId),
  index("missions_zip_idx").on(table.zip),
]);

export const missionUpdates = pgTable("mission_updates", {
  id: uuid("id").defaultRandom().primaryKey(),
  missionId: uuid("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
  authorId: uuid("author_id").references(() => users.id),
  status: missionStatus("status"),
  message: text("message"),
  mediaUrl: text("media_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("mission_updates_mission_idx").on(table.missionId)]);

export const payments = pgTable("payments", {
  id: uuid("id").defaultRandom().primaryKey(),
  missionId: uuid("mission_id").notNull().references(() => missions.id),
  stripePaymentIntentId: text("stripe_payment_intent_id").notNull(),
  stripeTransferId: text("stripe_transfer_id"),
  amountCents: integer("amount_cents").notNull(),
  scoutPayoutCents: integer("scout_payout_cents").notNull(),
  platformFeeCents: integer("platform_fee_cents").notNull(),
  status: paymentStatus("status").notNull().default("unpaid"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("payments_payment_intent_idx").on(table.stripePaymentIntentId),
  index("payments_mission_idx").on(table.missionId),
]);
