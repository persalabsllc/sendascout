import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, after, test } from "node:test";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { PgDialect } from "drizzle-orm/pg-core";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const dialect = new PgDialect();
const customerId = "10000000-0000-4000-8000-000000000001";
const now = new Date("2026-09-19T16:00:00Z");
// Execute the production statement itself, not a simplified SQL copy or regex.
// Only the provider-verified inputs are supplied by this isolated test fixture.
const source = readFileSync("lib/stripe-payments.ts", "utf8");
const functionStart = source.indexOf("export async function recordSuccessfulPaymentIntent");
const queryStart = source.indexOf("const result = await db.execute(sql`", functionStart);
const queryEnd = source.indexOf("\n  `);", queryStart);
assert.ok(queryStart > functionStart && queryEnd > queryStart);
const buildQuery = new Function("sql", "row", "intent", "checkoutSessionId", "stripeChargeId", "balanceTransaction", "now", "preferredUntil", "lifecycleBundleId", "preferredScoutMissionMatch", "LEGAL_VERSION", "SCOUT_HANDBOOK_VERSION", "LATE_PAYMENT_REFUND_CODE",
  `return ${source.slice(queryStart + "const result = await db.execute(".length, queryEnd)}\n  \`;`);

before(async () => {
  for (const migration of readMigrationFiles({ migrationsFolder: "./db/migrations" })) {
    for (const statement of migration.sql) await db.exec(statement);
  }
  await db.query("INSERT INTO users(id,clerk_user_id,email,role) VALUES($1,'customer','customer@example.test','customer')", [customerId]);
});
after(() => db.close());

let counter = 0;
async function seed(template = true, status = "draft") {
  const id = `20000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
  await db.query(`INSERT INTO missions(id,customer_id,type,status,payment_status,title,instructions,address_line_1,city,state,zip,customer_price_cents,scout_payout_cents,platform_fee_cents,see_template_key,see_template_snapshot,see_service_level,see_window_hours,see_base_payout_cents,see_payout_cap_cents)
    VALUES($1,$2,'see',$3,'failed','Test check','Checklist','Fictional address','Sample City','NC','28562',3900,2200,1700,$4,$5,$6,$7,$8,$9)`,
  [id, customerId, status, template ? "property" : null, template ? {} : null, template ? "standard" : null, template ? 72 : null, template ? 2200 : null, template ? 3400 : null]);
  const { rows } = await db.query<{ id: string }>(`INSERT INTO payments(mission_id,customer_id,kind,amount_cents,scout_payout_cents,platform_fee_cents,status,livemode,stripe_customer_id,idempotency_key,stripe_transfer_group)
    VALUES($1,$2,'booking',3900,2200,1700,'failed',false,'cus_fixture',$3,$3) RETURNING id`, [id, customerId, `mission_${id}`]);
  return { mission: { id, bundleId: null }, payment: { id: rows[0].id, missionId: id, bundleId: null, customerId, amountCents: 3900, currency: "usd", stripeCustomerId: "cus_fixture", stripeTransferGroup: `mission_${id}`, kind: "booking" } };
}
async function publish(row: Awaited<ReturnType<typeof seed>>, at = now) {
  const query = buildQuery(sql, row, { id: `pi_${row.payment.id}`, livemode: false }, `cs_${row.payment.id}`, `ch_${row.payment.id}`, null, at.toISOString(), new Date(at.getTime() + 3600000).toISOString(), null, sql`FALSE`, "2026-08-29-v1", "2026-09-01-v1", "late_payment_refund_required");
  const q = dialect.sqlToQuery(query);
  return (await db.query<Record<string, number>>(q.sql, q.params)).rows[0];
}
async function state(id: string) {
  return (await db.query<{ status: string; payment_status: string; alert_generation: number; see_funded_at: Date | null; see_deadline_at: Date | null; see_assignment_cutoff_at: Date | null }>("SELECT * FROM missions WHERE id=$1", [id])).rows[0];
}

test("verified successful payment recovers a failed ledger and publishes a See It draft atomically", async () => {
  const row = await seed();
  const result = await publish(row);
  assert.equal(result.paid_count, 1);
  assert.equal(result.published_count, 1);
  assert.equal(result.audit_count, 1);
  assert.equal(result.late_refund_count, 0);
  const mission = await state(row.mission.id);
  assert.equal(mission.status, "open");
  assert.equal(mission.payment_status, "paid");
  assert.equal(mission.see_funded_at?.toISOString(), now.toISOString());
  assert.equal(mission.see_deadline_at?.toISOString(), "2026-09-22T16:00:00.000Z");
  assert.equal(mission.see_assignment_cutoff_at?.toISOString(), "2026-09-22T12:00:00.000Z");
  const replay = await publish(row, new Date("2026-09-20T16:00:00Z"));
  assert.equal(replay.published_count, 0);
  assert.equal(replay.audit_count, 0);
  assert.equal((await state(row.mission.id)).see_deadline_at?.toISOString(), mission.see_deadline_at?.toISOString());
  assert.equal((await state(row.mission.id)).alert_generation, mission.alert_generation);
});

test("legacy See It bookings still publish without acquiring new template deadlines", async () => {
  const row = await seed(false);
  assert.equal((await publish(row)).published_count, 1);
  assert.equal((await state(row.mission.id)).see_funded_at, null);
  assert.equal((await state(row.mission.id)).see_deadline_at, null);
});

test("replayed success does not reopen a funded mission deliberately pulled by support", async () => {
  const row = await seed();
  await publish(row);
  await db.query("UPDATE missions SET status='draft' WHERE id=$1", [row.mission.id]);
  const result = await publish(row);
  assert.equal(result.published_count, 0);
  assert.equal(result.late_refund_count, 0);
  assert.equal((await state(row.mission.id)).status, "draft");
});

test("cancelled, archived and disputed missions do not reopen on payment recovery", async () => {
  for (const status of ["cancelled", "disputed", "draft"]) {
    const row = await seed(true, status);
    if (status === "draft") await db.query("UPDATE missions SET archived_at=now() WHERE id=$1", [row.mission.id]);
    const result = await publish(row);
    assert.equal(result.paid_count, 1);
    assert.equal(result.published_count, 0);
    assert.equal(result.late_refund_count, 1);
    assert.equal((await state(row.mission.id)).status, status);
  }
});

test("audit insertion failure rolls back the payment and mission together", async () => {
  const row = await seed();
  await db.exec("CREATE FUNCTION reject_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$; CREATE TRIGGER reject_publication BEFORE INSERT ON mission_updates FOR EACH ROW EXECUTE FUNCTION reject_publication();");
  try { await assert.rejects(publish(row), /audit unavailable/); }
  finally { await db.exec("DROP TRIGGER reject_publication ON mission_updates; DROP FUNCTION reject_publication();"); }
  assert.equal((await state(row.mission.id)).status, "draft");
  const payment = (await db.query<{ status: string; paid_at: Date | null }>("SELECT status,paid_at FROM payments WHERE id=$1", [row.payment.id])).rows[0];
  assert.equal(payment.status, "failed");
  assert.equal(payment.paid_at, null);
});
