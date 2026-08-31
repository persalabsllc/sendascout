import { neon } from "@neondatabase/serverless";

const BACKUP_SCHEMA = "pre_stripe_production_20260831";

if (process.env.VERCEL !== "1" || process.env.VERCEL_ENV !== "production") {
  throw new Error("The Production schema backup may only run during a Vercel Production build.");
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to back up the Production database.");
}

const database = neon(connectionString);
const [state] = await database.query(`
  SELECT
    to_regnamespace('${BACKUP_SCHEMA}') IS NOT NULL AS has_backup,
    EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'users'
        AND column_name = 'stripe_customer_id'
    ) AS stripe_migration_applied
`);

if (state?.stripe_migration_applied) {
  console.log("Production Stripe schema is already present; no pre-migration backup is needed.");
  process.exit(0);
}

if (state?.has_backup) {
  const [backupState] = await database.query(`
    SELECT
      to_regclass('${BACKUP_SCHEMA}.users') IS NOT NULL AS has_users,
      to_regclass('${BACKUP_SCHEMA}.__drizzle_migrations') IS NOT NULL AS has_migration_ledger
  `);
  if (!backupState?.has_users || !backupState?.has_migration_ledger) {
    throw new Error(`Backup schema ${BACKUP_SCHEMA} exists but is incomplete. Stop and inspect it manually.`);
  }

  console.log(`Verified existing Production backup schema ${BACKUP_SCHEMA}.`);
  process.exit(0);
}

await database.transaction((transaction) => [
  transaction`SET LOCAL lock_timeout = '15s'`,
  transaction`SET LOCAL statement_timeout = '5min'`,
  transaction`SELECT pg_advisory_xact_lock(hashtext('sendascout:pre-stripe-production-backup'))`,
  transaction`${transaction.unsafe(`CREATE SCHEMA "${BACKUP_SCHEMA}"`)}`,
  transaction`${transaction.unsafe(`
    DO $backup$
    DECLARE
      source_table record;
    BEGIN
      FOR source_table IN
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
        ORDER BY tablename
      LOOP
        EXECUTE format(
          'CREATE TABLE %I.%I AS TABLE public.%I',
          '${BACKUP_SCHEMA}',
          source_table.tablename,
          source_table.tablename
        );
      END LOOP;
    END
    $backup$
  `)}`,
  transaction`${transaction.unsafe(`
    CREATE TABLE "${BACKUP_SCHEMA}"."__drizzle_migrations"
    AS TABLE drizzle.__drizzle_migrations
  `)}`,
]);

console.log(`Created Production backup schema ${BACKUP_SCHEMA}.`);
