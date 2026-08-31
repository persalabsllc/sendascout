import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const paymentService = readFileSync(new URL("../lib/stripe-payments.ts", import.meta.url), "utf8");
const lateRefundService = readFileSync(new URL("../lib/stripe-late-payment-refunds.ts", import.meta.url), "utf8");
const settlementService = readFileSync(new URL("../lib/stripe-settlement.ts", import.meta.url), "utf8");
const operationsCron = readFileSync(new URL("../app/api/cron/auto-complete/route.ts", import.meta.url), "utf8");

test("only a first success that is already ineligible receives the late-refund marker", () => {
  assert.match(paymentService, /WITH locked_missions AS MATERIALIZED/);
  assert.match(paymentService, /locked_missions[\s\S]*ORDER BY locked_mission\.id[\s\S]*FOR UPDATE OF locked_mission[\s\S]*locked_bundle AS MATERIALIZED[\s\S]*FOR UPDATE OF locked_parent[\s\S]*payment_eligibility AS MATERIALIZED/);
  assert.match(paymentService, /INNER JOIN locked_missions AS root ON root\.id = candidate\.mission_id/);
  assert.match(paymentService, /SELECT 1 FROM locked_missions AS ineligible_leg/);
  assert.match(paymentService, /payment\.paid_at IS NULL[\s\S]*NOT COALESCE\(\(SELECT eligible FROM payment_eligibility\), FALSE\)/);
  assert.match(paymentService, /payment\.failure_code = \$\{LATE_PAYMENT_REFUND_CODE\}/);
  assert.match(paymentService, /WHEN candidate\.kind = 'booking'/);
  assert.match(paymentService, /WHEN candidate\.kind = 'meet_adjustment'/);
  assert.match(paymentService, /WHEN candidate\.kind = 'change_order'/);
  assert.match(paymentService, /WHEN candidate\.kind = 'tip'/);
});

test("successful payment audit binds a typed preferred-scout boolean", () => {
  assert.match(paymentService, /const hasPreferredScout = row\.mission\.preferredScoutId !== null;/);
  assert.match(paymentService, /CASE WHEN \$\{hasPreferredScout\}/);
  assert.doesNotMatch(paymentService, /CASE WHEN \$\{row\.mission\.preferredScoutId\} IS NULL/);
});

test("successful payment reads raw Neon results from the rows collection", () => {
  assert.match(paymentService, /const summary = result\.rows\[0\]/);
  assert.doesNotMatch(paymentService, /result\[0\]\?\.(?:paid_count|published_count|late_refund_count)/);
});

test("an ineligible booking is not published or propagated to bundle legs", () => {
  assert.match(paymentService, /published_root[\s\S]*COALESCE\(\(SELECT eligible FROM payment_eligibility\), FALSE\)/);
  assert.match(paymentService, /marked_children[\s\S]*EXISTS \(SELECT 1 FROM published_root\)/);
  assert.match(paymentService, /refundLatePaymentBestEffort\(row\.payment\.id, "payment_success"\)/);
});

test("late-payment recovery refunds only the exact charge and never infers a Scout reversal", () => {
  assert.match(lateRefundService, /requestPaymentRefund\(\{/);
  assert.match(lateRefundService, /paymentId: state\.paymentId/);
  assert.match(lateRefundService, /amountCents: state\.residualCents/);
  assert.match(lateRefundService, /idempotencyKey: `late-payment:\$\{state\.paymentId\}:refund:v2:from-\$\{state\.targetCents - state\.residualCents\}:attempt-\$\{state\.lateRequestCount \+ 1\}`/);
  assert.doesNotMatch(lateRefundService, /reverseScoutTransfer/);
});

test("late-refund-required payments can never fund a Scout transfer", () => {
  assert.match(settlementService, /import \{ LATE_PAYMENT_REFUND_CODE \} from "@\/lib\/stripe-late-payment-refunds"/);
  const sqlGuards = settlementService.match(/funding_payment\.failure_code IS DISTINCT FROM \$\{LATE_PAYMENT_REFUND_CODE\}/g) ?? [];
  assert.ok(sqlGuards.length >= 2);
  assert.match(settlementService, /payment\.failureCode === LATE_PAYMENT_REFUND_CODE/);
  assert.match(settlementService, /scope\.payment\.failureCode === LATE_PAYMENT_REFUND_CODE/);
});

test("late-payment retries reserve only uncovered charge capacity", () => {
  assert.match(lateRefundService, /GREATEST\(refund_totals\.refunded_amount_cents, refund_totals\.ledger_succeeded_cents\)/);
  assert.match(lateRefundService, /refund\.status IN \('pending', 'requires_action'\)/);
  assert.match(lateRefundService, /normalized\.target_cents[\s\S]*normalized\.succeeded_cents[\s\S]*normalized\.ledger_pending_cents[\s\S]*AS residual_cents/);
  assert.match(lateRefundService, /if \(state\.residualCents <= 0\) return state/);
});

test("each durable late-refund request advances a deterministic retry generation", () => {
  assert.match(lateRefundService, /refund\.status IN \('failed', 'canceled'\)[\s\S]*refund\.reason = \('late-payment:' \|\| payment\.kind\)/);
  assert.match(lateRefundService, /COUNT\(refund\.id\) FILTER \([\s\S]*refund\.reason = \('late-payment:' \|\| payment\.kind\)[\s\S]*AS late_request_count/);
  assert.match(lateRefundService, /attempt-\$\{state\.lateRequestCount \+ 1\}/);
});

test("hourly recovery prioritizes invalid late charges before case and support allocation", () => {
  const addonIndex = operationsCron.indexOf("await reconcilePaidAddonApplications()");
  const lateIndex = operationsCron.indexOf("await reconcileLatePaymentRefunds()");
  const caseIndex = operationsCron.indexOf("await reconcileMissionCaseRefunds()");
  const supportIndex = operationsCron.indexOf("await reconcileApprovedSupportRefunds()");
  assert.ok(addonIndex > 0);
  assert.ok(addonIndex < lateIndex);
  assert.ok(lateIndex > 0);
  assert.ok(lateIndex < caseIndex);
  assert.ok(lateIndex < supportIndex);
});

test("paid change orders and tips recover application crashes before exact-charge refund recovery", () => {
  assert.match(paymentService, /export async function reconcilePaidAddonApplications/);
  assert.match(paymentService, /paid_addon\.kind = 'change_order'[\s\S]*requested\.status NOT IN \('approved', 'fulfilled'\)/);
  assert.match(paymentService, /paid_addon\.kind = 'tip'[\s\S]*review\.tip_status <> 'paid'/);
  assert.match(paymentService, /applyPaidAddonPayment\(row\.id\)/);
  assert.match(paymentService, /markPaidAddonForLateRefund[\s\S]*failureCode: LATE_PAYMENT_REFUND_CODE[\s\S]*refundLatePaymentBestEffort\(paymentId, source\)/);
});

test("late tip and change-order paths cannot silently resurrect ineligible scopes", () => {
  assert.match(paymentService, /tipStatus, \["unpaid", "pending", "requires_action", "processing", "authorized", "failed"\]/);
  assert.match(paymentService, /"tip_no_longer_eligible"/);
  assert.match(paymentService, /"change_order_no_longer_eligible"/);
  assert.match(paymentService, /"change_order_apply_race"/);
  assert.match(paymentService, /currentState === "applied"/);
});
