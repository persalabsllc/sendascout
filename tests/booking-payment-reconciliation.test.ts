import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, after, test } from "node:test";
import ts from "typescript";
import * as orm from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { PGlite } from "@electric-sql/pglite";
import * as schema from "../db/schema.ts";
import { bookingBlockedReason, bookingMissionStatus, paymentErrorDiagnostic } from "../lib/payment-presentation.ts";

const pg = new PGlite();
const db = drizzle(pg, { schema });
const customerId = "10000000-0000-4000-8000-000000000001";
let providerReads = 0;
let applied = 0;
let stateUpdates = 0;
let failApply = false;
let session: Record<string, unknown>;
let intent: Record<string, unknown>;

// Run the actual service against PostgreSQL with only Stripe and publication
// side effects replaced. Unknown imports/provider calls fail closed.
function loadService(path: string) {
  const modules: Record<string, unknown> = {
    "server-only": {}, "drizzle-orm": orm, "@/db": { getDb: () => db }, "@/db/schema": schema,
    "@/lib/payment-presentation": { paymentErrorDiagnostic },
    "@/lib/observability": { reportOperationalEvent: async () => null },
    "@/lib/stripe": { getStripeLivemode: () => false, stripeObjectId: (value: unknown) => typeof value === "string" ? value : (value as { id?: string } | null)?.id ?? null,
      getStripe: () => ({ checkout: { sessions: { retrieve: async () => { providerReads++; return session; } } }, paymentIntents: { retrieve: async () => { providerReads++; return intent; } } }) },
    "@/lib/stripe-payments": {
      recordPaymentIntentState: async () => { stateUpdates++; },
      recordSuccessfulPaymentIntent: async (verified: { metadata: { sendascout_payment_id: string } }) => {
        applied++;
        if (failApply) throw new Error("database unavailable");
        await db.update(schema.payments).set({ status: "paid", paidAt: new Date() }).where(orm.eq(schema.payments.id, verified.metadata.sendascout_payment_id));
      },
    },
  };
  const exports: Record<string, (...args: unknown[]) => Promise<Record<string, unknown>>> = {};
  const js = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "exports", js)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected module: ${name}`);
    return modules[name];
  }, exports);
  return exports;
}
const service = loadService("lib/stripe-payment-reconciliation.ts");
before(async () => {
  for (const migration of readMigrationFiles({ migrationsFolder: "./db/migrations" })) for (const statement of migration.sql) await pg.exec(statement);
  await db.insert(schema.users).values({ id: customerId, clerkUserId: "fixture", email: "fixture@example.test", role: "customer" });
});
after(() => pg.close());

async function seed() {
  providerReads = 0; applied = 0; stateUpdates = 0; failApply = false;
  const [mission] = await db.insert(schema.missions).values({ customerId, type: "see", title: "Fixture", instructions: "Fixture", addressLine1: "Fictional", city: "Sample", state: "NC", zip: "28562", customerPriceCents: 3900, scoutPayoutCents: 2200, platformFeeCents: 1700 }).returning();
  const [payment] = await db.insert(schema.payments).values({ customerId, missionId: mission.id, kind: "booking", status: "failed", amountCents: 3900, scoutPayoutCents: 2200, platformFeeCents: 1700, idempotencyKey: `fixture_${mission.id}`, stripeTransferGroup: `mission_${mission.id}`, stripeCustomerId: "cus_fixture", stripeCheckoutSessionId: `cs_${mission.id}`, livemode: false }).returning();
  const metadata = { sendascout_payment_id: payment.id, sendascout_mission_id: mission.id, sendascout_customer_id: customerId, sendascout_payment_kind: "booking" };
  session = { id: payment.stripeCheckoutSessionId, livemode: false, customer: "cus_fixture", amount_total: 3900, currency: "usd", payment_intent: "pi_fixture", metadata };
  intent = { id: "pi_fixture", livemode: false, customer: "cus_fixture", amount: 3900, currency: "usd", status: "succeeded", transfer_group: payment.stripeTransferGroup, metadata };
  return payment;
}

test("recovery checks the existing provider objects and applies success only once", async () => {
  const payment = await seed();
  assert.equal((await service.reconcileBookingPayment(payment.id, customerId)).status, "paid");
  assert.equal(providerReads, 2);
  assert.equal(applied, 1);
  assert.equal((await service.reconcileBookingPayment(payment.id, customerId)).status, "paid");
  assert.equal(providerReads, 2);
  assert.equal(applied, 1);
});

test("a different customer cannot query or reconcile someone else's payment", async () => {
  const payment = await seed();
  await assert.rejects(service.reconcileBookingPayment(payment.id, "10000000-0000-4000-8000-000000000009"), /not found/);
  assert.equal(providerReads, 0);
  assert.equal(applied, 0);
});

test("Checkout and PaymentIntent identity, mode, amount and currency mismatches fail closed", async () => {
  for (const target of ["session", "intent"]) {
    for (const [key, value] of Object.entries({ livemode: true, customer: "cus_other", currency: "eur", [target === "session" ? "amount_total" : "amount"]: 4900, metadata: {} })) {
      const payment = await seed();
      if (target === "session") session[key] = value; else intent[key] = value;
      await assert.rejects(service.reconcileBookingPayment(payment.id, customerId), /identity does not match/);
      assert.equal(applied, 0);
      assert.equal(stateUpdates, 0);
    }
  }
});

test("an unsettled provider payment stays unsettled; no checkout is created", async () => {
  const payment = await seed();
  intent.status = "processing";
  await service.reconcileBookingPayment(payment.id, customerId);
  assert.equal(applied, 0);
  assert.equal(stateUpdates, 1);
});

test("payment issue visibility joins the failed success webhook to its booking and clears after confirmation", async () => {
  const payment = await seed();
  await db.insert(schema.stripeWebhookEvents).values({ eventId: `evt_${payment.id}`, type: "checkout.session.completed", scope: "platform", objectId: payment.stripeCheckoutSessionId, livemode: false, eventCreatedAt: new Date(), status: "failed" });
  const flag = loadService("lib/booking-payment-queries.ts").bookingConfirmationFailed as unknown as orm.SQL<boolean>;
  const query = () => db.select({ failed: flag }).from(schema.payments).where(orm.eq(schema.payments.id, payment.id));
  assert.equal((await query())[0].failed, true);
  await service.reconcileBookingPayment(payment.id, customerId);
  assert.equal((await query())[0].failed, false);
});

test("a newly created PaymentIntent is pending, not failed, unless Stripe reports a real error", () => {
  const code = readFileSync("lib/stripe-payments.ts", "utf8");
  const fn = code.slice(code.indexOf("function paymentIntentLedgerStatus"));
  const js = ts.transpileModule(fn, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const classify = new Function(`${js}; return paymentIntentLedgerStatus;`)();
  assert.equal(classify("requires_payment_method", false), "pending");
  assert.equal(classify("requires_payment_method", true), "failed");
  assert.equal(classify("processing", false), "processing");
});

test("publication failure is retryable without a second charge or fabricated success", async () => {
  const payment = await seed();
  failApply = true;
  await assert.rejects(service.reconcileBookingPayment(payment.id, customerId), /database unavailable/);
  assert.equal(stateUpdates, 0);
  assert.equal((await db.select().from(schema.payments).where(orm.eq(schema.payments.id, payment.id)))[0].status, "failed");
});

test("draft labels distinguish payment confirmation from a genuine funded hold", () => {
  assert.equal(bookingMissionStatus("draft", "pending"), "Awaiting payment confirmation");
  assert.equal(bookingMissionStatus("draft", "failed", true), "Payment confirmation delayed");
  assert.equal(bookingMissionStatus("draft", "paid"), "Paused by support");
  assert.match(bookingBlockedReason("draft", "failed", true)!, /do not ask the customer to pay again/);
  assert.equal(bookingBlockedReason("open", "paid"), null);
});

test("payment diagnostics retain the root database code without exposing query parameters", () => {
  const result = paymentErrorDiagnostic(new Error("SQL plus sensitive parameters", { cause: { code: "42804", message: "column mismatch" } }));
  assert.equal(result.code, "42804");
  assert.doesNotMatch(JSON.stringify(result), /sensitive|SQL|parameters/);
});

test("reconciliation actions enforce roles and checkout return matches an owned ledger entry", () => {
  const actions = readFileSync("app/actions/payment-reconciliation.ts", "utf8");
  assert.match(actions, /await requireAdminUser\(\)/);
  assert.match(actions, /reconcile\(paymentId, user.id\)/);
  const page = readFileSync("app/dashboard/customer/payments/page.tsx", "utf8");
  assert.match(page, /where\(eq\(payments.customerId, user.id\)\)/);
  assert.match(page, /payment.stripeCheckoutSessionId === sessionId/);
  assert.match(readFileSync("app/api/cron/see-it/route.ts", "utf8"), /reconcilePendingBookingPayments/);
});
