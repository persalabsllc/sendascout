import { neon } from "@neondatabase/serverless";
import { readMigrationFiles } from "drizzle-orm/migrator";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) throw new Error("DATABASE_URL is required to run database migrations.");

const database = neon(connectionString);
const migrations = readMigrationFiles({ migrationsFolder: "./db/migrations" });

await database.query("CREATE SCHEMA IF NOT EXISTS drizzle");
await database.query(`
  CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
    id SERIAL PRIMARY KEY,
    hash text NOT NULL,
    created_at bigint
  )
`);

const applied = await database.query("SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC");
if (applied.length > migrations.length) {
  throw new Error("The database migration ledger contains entries that are not present in this repository.");
}
for (let index = 0; index < applied.length; index += 1) {
  const row = applied[index];
  const expected = migrations[index];
  const createdAt = Number(row.created_at);
  if (!Number.isSafeInteger(createdAt) || createdAt !== expected.folderMillis) {
    throw new Error(`The database migration ledger is not a contiguous repository prefix at position ${index}. Stop and reconcile it manually.`);
  }
  if (String(row.hash) !== expected.hash) {
    throw new Error(`Applied migration ${createdAt} does not match the repository hash. Add a corrective migration instead of editing history.`);
  }
}

if (!applied.length) {
  const [existingSchema] = await database.query(`
    SELECT
      to_regclass('public.users') IS NOT NULL
      OR to_regclass('public.missions') IS NOT NULL
      OR to_regclass('public.payments') IS NOT NULL AS has_application_schema
  `);
  if (existingSchema?.has_application_schema) {
    throw new Error("Application tables exist without a migration ledger. Stop and reconcile the database manually before running migrations.");
  }
}

const lastAppliedAt = applied.length ? Number(applied.at(-1).created_at) : -1;
const pending = migrations.slice(applied.length);
if (!pending.length) {
  console.log("Database migrations are current.");
  process.exit(0);
}

const stripeMigration = pending.find((migration) => migration.folderMillis === 1788152400000);
if (stripeMigration && lastAppliedAt >= migrations[0].folderMillis) {
  const [partial] = await database.query(`
    SELECT
      to_regtype('public.payment_transaction_status') IS NOT NULL AS has_payment_status,
      to_regclass('public.payment_transfers') IS NOT NULL AS has_transfers,
      to_regclass('public.payment_refunds') IS NOT NULL AS has_refunds,
      to_regclass('public.stripe_webhook_events') IS NOT NULL AS has_webhooks,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND ((table_name = 'users' AND column_name = 'stripe_customer_id')
            OR (table_name = 'payments' AND column_name = 'bundle_id'))
      ) AS has_stripe_columns,
      EXISTS (
        SELECT 1 FROM pg_enum AS enum_value
        INNER JOIN pg_type AS enum_type ON enum_type.oid = enum_value.enumtypid
        WHERE enum_type.typname = 'payment_status' AND enum_value.enumlabel = 'pending'
      ) AS has_extended_payment_enum
  `);
  if (partial && Object.values(partial).some(Boolean)) {
    throw new Error("Partial Stripe migration artifacts already exist without a migration record. Stop and reconcile the database manually before retrying.");
  }

  const hasRevenueBundleSchema = lastAppliedAt >= 1788060242512;
  const duplicateBundlePaymentsSql = hasRevenueBundleSchema
    ? `(SELECT COUNT(*)::integer FROM (
        SELECT mission.bundle_id
        FROM payments AS payment
        INNER JOIN missions AS mission ON mission.id = payment.mission_id
        WHERE mission.bundle_id IS NOT NULL
        GROUP BY mission.bundle_id HAVING COUNT(*) > 1
      ) AS duplicate_bundles)`
    : "0::integer";
  const [preflight] = await database.query(`
    SELECT
      (SELECT COUNT(*)::integer FROM (
        SELECT stripe_account_id FROM scout_profiles
        WHERE stripe_account_id IS NOT NULL
        GROUP BY stripe_account_id HAVING COUNT(*) > 1
      ) AS duplicate_accounts) AS duplicate_accounts,
      (SELECT COUNT(*)::integer FROM (
        SELECT mission_id FROM payments GROUP BY mission_id HAVING COUNT(*) > 1
      ) AS duplicate_mission_payments) AS duplicate_mission_payments,
      ${duplicateBundlePaymentsSql} AS duplicate_bundle_payments,
      (SELECT COUNT(*)::integer FROM payments
        WHERE amount_cents < 0 OR scout_payout_cents < 0 OR platform_fee_cents < 0
          OR amount_cents <> scout_payout_cents + platform_fee_cents
      ) AS invalid_payment_amounts,
      (SELECT COUNT(*)::integer FROM payments
        WHERE status::text IN ('authorized', 'paid')
      ) AS unreconciled_legacy_payments
  `);
  if (preflight && Object.values(preflight).some((value) => Number(value) > 0)) {
    throw new Error(`Stripe migration preflight failed: ${JSON.stringify(preflight)}.`);
  }
}

const statements = pending.flatMap((migration) => migration.sql.map((statement) => statement.trim()).filter(Boolean));
await database.transaction((transaction) => [
  transaction`SET LOCAL lock_timeout = '15s'`,
  transaction`SET LOCAL statement_timeout = '5min'`,
  transaction`SELECT pg_advisory_xact_lock(hashtext('sendascout:database-migrations'))`,
  transaction`SELECT 1 / CASE
    WHEN COALESCE((SELECT MAX(created_at) FROM drizzle.__drizzle_migrations), -1) = ${lastAppliedAt}
    THEN 1 ELSE 0 END AS migration_state_unchanged`,
  ...statements.map((statement) => transaction`${transaction.unsafe(statement)}`),
  ...pending.map((migration) => transaction`
    INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
    VALUES (${migration.hash}, ${migration.folderMillis})
  `),
]);

console.log(`Applied ${pending.length} migration${pending.length === 1 ? "" : "s"} atomically.`);
