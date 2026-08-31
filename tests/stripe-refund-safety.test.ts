import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const refundService = readFileSync(new URL("../lib/stripe-refunds.ts", import.meta.url), "utf8");

test("refund allocations serialize and reserve pending amounts", () => {
  assert.match(refundService, /isolationLevel: "Serializable"/);
  assert.match(refundService, /refund\.status = 'succeeded'/);
  assert.match(refundService, /refund\.status IN \('pending', 'requires_action'\)/);
  assert.match(refundService, /GREATEST\(\s*locked\.refunded_amount_cents,[\s\S]*\+ COALESCE\(\(/);
  assert.doesNotMatch(refundService, /refund\.status IN \('pending', 'requires_action', 'succeeded'\)/);
});

test("refund allocation respects an in-flight transfer commitment", () => {
  const commitmentGuards = refundService.match(/committed_transfer\.status = 'processing'/g) ?? [];
  assert.equal(commitmentGuards.length, 2);
  assert.match(refundService, /committed_transfer\.payment_id = candidate\.id/);
});

test("refund and transfer reversal calls use durable idempotency keys", () => {
  assert.match(refundService, /refunds\.create\([\s\S]*idempotencyKey: record\.refund\.idempotencyKey/);
  assert.match(refundService, /transfers\.createReversal\([\s\S]*idempotencyKey: record\.reversal\.idempotencyKey/);
});

test("refund and explicit reversal intents allocate atomically and remain recoverable", () => {
  assert.match(refundService, /serializableRequestRows\([\s\S]*REVERSAL_ALLOCATION_SQL/);
  assert.match(refundService, /transaction\.query\(refundQuery[\s\S]*transaction\.query\(REVERSAL_ALLOCATION_SQL/);
  assert.match(refundService, /export async function reconcileMissingPaymentTransferReversals\(limit = 25\)/);
  assert.match(refundService, /desiredReversalCents > amountCents/);
  assert.match(refundService, /cannot exceed the customer refund amount/);
});

test("Scout clawback is explicit and separate from Stripe charge refunds", () => {
  assert.match(refundService, /reverseScoutTransfer\?: boolean/);
  assert.match(refundService, /if \(input\.reverseScoutTransfer\)/);
  assert.doesNotMatch(refundService, /reverse_transfer\s*:/);
  assert.doesNotMatch(refundService, /paymentDisputes/);
});

test("refund request policy is part of the durable idempotency identity", () => {
  assert.match(refundService, /const policy = reverseScoutTransfer \? `reverse_\$\{reversalAmountCents\}` : "no_reversal"/);
  assert.match(refundService, /different Scout reversal policy/);
  assert.match(refundService, /different Scout reversal amount/);
});

test("single-payment refunds cannot spill onto another charge or a legacy transfer scope", () => {
  const paymentRefundRequest = refundService.slice(
    refundService.indexOf("export async function requestPaymentRefund"),
    refundService.indexOf("export async function reconcileMissionCaseRefunds"),
  );
  assert.match(refundService, /export async function requestPaymentRefund\(input: PaymentRefundRequest\): Promise<PaymentRefundResult>/);
  assert.match(refundService, /candidate\.id = \$1::uuid/);
  assert.match(refundService, /candidate\.legacy_stripe_transfer_id IS NULL/);
  assert.match(refundService, /OR payment\.id = \$5::uuid/);
  assert.match(refundService, /legacy Stripe transfer scope that requires manual reconciliation/);
  assert.match(paymentRefundRequest, /if \(!input\.deferProcessing\) \{[\s\S]*processPaymentRefund\(refund\.id\)/);
});

test("mission refunds exclude tips and duplicate charges while exact-payment refunds can target them", () => {
  assert.match(refundService, /candidate\.kind NOT IN \('tip', 'duplicate'\)/);
  assert.match(refundService, /\(\$5::uuid IS NULL AND payment\.kind NOT IN \('tip', 'duplicate'\)\)/);
  assert.match(refundService, /validateRefundReplay\([\s\S]*prefixes\.refund,[\s\S]*false,/);
  assert.match(refundService, /Mission-level refunds cannot include tips/);
  assert.match(refundService, /Mission-level refunds cannot reverse tip transfers/);
});

test("successful refunds synchronize payment and mission aggregate ledgers", () => {
  assert.match(refundService, /pg_advisory_xact_lock\(hashtextextended\([\s\S]*'stripe-financial-scope:'/);
  assert.doesNotMatch(refundService, /getDb\(\)\.transaction\(async/);
  assert.match(refundService, /UPDATE payments AS payment[\s\S]*refunded_amount_cents/);
  assert.match(refundService, /UPDATE mission_reviews AS review[\s\S]*tip_status/);
  assert.match(refundService, /payment\.kind NOT IN \('tip', 'duplicate'\)/);
  assert.match(refundService, /UPDATE missions AS mission[\s\S]*payment_status = \(SELECT status FROM aggregate_status\)/);
  assert.match(refundService, /UPDATE mission_bundles AS bundle[\s\S]*payment_status = \(SELECT status FROM aggregate_status\)/);
  assert.match(refundService, /'partially_refunded'::payment_status/);
  assert.match(refundService, /'refunded'::payment_status/);
});

test("resolved mission case refunds have a deterministic crash-recovery worker", () => {
  assert.match(refundService, /export async function reconcileMissionCaseRefunds\(limit = 25\)/);
  assert.match(refundService, /eq\(missionCases\.status, "resolved"\)/);
  assert.match(refundService, /idempotencyKey: `mission-case:\$\{missionCase\.id\}:refund:v1`/);
  assert.match(refundService, /missionCaseId: missionCase\.id/);
  assert.match(refundService, /reason: missionCaseRefundReason\(missionCase\.id\)/);
});

test("unlinked mission-case reservations remain deferred until a case authorizes them", () => {
  assert.match(refundService, /isNull\(paymentRefunds\.missionCaseId\)[\s\S]*NOT LIKE 'mission-case:%'/);
  assert.match(refundService, /if \(!input\.deferProcessing\) \{[\s\S]*for \(const refund of refunds\) await processPaymentRefund\(refund\.id\)/);
});

test("approved support refunds have a deterministic crash-recovery worker", () => {
  const supportWorker = refundService.slice(
    refundService.indexOf("export async function reconcileApprovedSupportRefunds"),
    refundService.indexOf("export async function processPendingPaymentRefunds"),
  );
  assert.match(refundService, /export async function reconcileApprovedSupportRefunds\(limit = 25\)/);
  assert.match(refundService, /eq\(customerSupportTickets\.status, "closed"\)/);
  assert.match(refundService, /eq\(customerSupportTickets\.customerDecision, "approved"\)/);
  assert.match(refundService, /idempotencyKey: `support-ticket:\$\{ticket\.id\}:refund:v1`/);
  assert.match(refundService, /reason: `support-ticket:\$\{ticket\.id\}`/);
  assert.doesNotMatch(supportWorker, /reverseScoutTransfer/);
});

test("manual case transfer reversals remain durable while settlement is still possible", () => {
  assert.match(refundService, /transfer\.kind === "manual" && transfer\.idempotencyKey\.startsWith\("transfer:case:"\)/);
  assert.match(refundService, /Waiting for the case-authorized Scout transfer to settle before reversing it/);
});
