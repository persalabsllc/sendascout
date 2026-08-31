import { neon } from "@neondatabase/serverless";

const previewEnvironment = process.env.VERCEL_ENV === "preview";
const stripeBranch = process.env.VERCEL_GIT_COMMIT_REF === "codex/stripe-connect";

if (!previewEnvironment || !stripeBranch) {
  console.log("Skipping guarded Stripe database preparation outside the dedicated preview branch.");
  process.exit(0);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for guarded Stripe database preparation.");

const database = neon(connectionString);
const backupSchema = "pre_stripe_20260831";

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

await database.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(backupSchema)}`);
await database.query(`
  CREATE TABLE IF NOT EXISTS ${quoteIdentifier(backupSchema)}.__backup_metadata (
    key text PRIMARY KEY,
    value jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  )
`);
await database.query(`
  CREATE TABLE IF NOT EXISTS ${quoteIdentifier(backupSchema)}.__table_counts (
    table_name text PRIMARY KEY,
    row_count bigint NOT NULL,
    copied_at timestamp with time zone DEFAULT now() NOT NULL
  )
`);

const completed = await database.query(`
  SELECT value
  FROM ${quoteIdentifier(backupSchema)}.__backup_metadata
  WHERE key = 'backup_complete'
  LIMIT 1
`);

if (!completed.length) {
  const publicTables = await database.query(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);

  for (const { tablename } of publicTables) {
    if (!/^[a-zA-Z0-9_]+$/.test(tablename)) {
      throw new Error(`Unexpected public table name: ${tablename}`);
    }
    const source = `${quoteIdentifier("public")}.${quoteIdentifier(tablename)}`;
    const target = `${quoteIdentifier(backupSchema)}.${quoteIdentifier(tablename)}`;
    const [targetState] = await database.query(`SELECT to_regclass('${backupSchema}.${tablename}') IS NOT NULL AS exists`);
    if (!targetState?.exists) {
      await database.query(`CREATE TABLE ${target} AS TABLE ${source} WITH DATA`);
    }
    const [sourceCount] = await database.query(`SELECT COUNT(*)::bigint AS count FROM ${source}`);
    const [targetCount] = await database.query(`SELECT COUNT(*)::bigint AS count FROM ${target}`);
    if (String(sourceCount?.count) !== String(targetCount?.count)) {
      throw new Error(`Backup verification failed for ${tablename}.`);
    }
    await database.query(
      `INSERT INTO ${quoteIdentifier(backupSchema)}.__table_counts (table_name, row_count)
       VALUES ($1, $2)
       ON CONFLICT (table_name) DO NOTHING`,
      [tablename, targetCount.count],
    );
  }

  const [migrationLedger] = await database.query(`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists`);
  if (migrationLedger?.exists) {
    const target = `${quoteIdentifier(backupSchema)}.${quoteIdentifier("__drizzle_migrations")}`;
    const [targetState] = await database.query(`SELECT to_regclass('${backupSchema}.__drizzle_migrations') IS NOT NULL AS exists`);
    if (!targetState?.exists) {
      await database.query(`CREATE TABLE ${target} AS TABLE drizzle.__drizzle_migrations WITH DATA`);
    }
  }

  await database.query(
    `INSERT INTO ${quoteIdentifier(backupSchema)}.__backup_metadata (key, value)
     VALUES ('backup_complete', $1::jsonb)
     ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify({ schema: backupSchema, tableCount: publicTables.length })],
  );
  console.log(`Created and verified pre-Stripe backup schema ${backupSchema}.`);
} else {
  console.log(`Verified existing pre-Stripe backup marker in ${backupSchema}.`);
}

await import("./migrate.mjs");
