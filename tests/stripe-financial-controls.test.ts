import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const payments = readFileSync(new URL("../lib/stripe-payments.ts", import.meta.url), "utf8");
const refunds = readFileSync(new URL("../lib/stripe-refunds.ts", import.meta.url), "utf8");
const refundCapacity = readFileSync(new URL("../lib/stripe-refund-capacity.ts", import.meta.url), "utf8");
const operations = readFileSync(new URL("../app/actions/operations.ts", import.meta.url), "utf8");
const support = readFileSync(new URL("../app/actions/support.ts", import.meta.url), "utf8");
const missionActions = readFileSync(new URL("../app/actions/missions.ts", import.meta.url), "utf8");

test("a paid payment identity is immutable while a non-success identity may be replaced", () => {
  assert.match(payments, /payment\.paid_at IS NULL[\s\S]*payment\.stripe_payment_intent_id IS NULL[\s\S]*payment\.stripe_payment_intent_id = \$\{intent\.id\}/);
  assert.match(payments, /payment\.paid_at IS NULL[\s\S]*payment\.stripe_charge_id IS NULL[\s\S]*payment\.stripe_charge_id = \$\{stripeChargeId\}/);
  assert.match(payments, /duplicate_payment_intent_\$\{intent\.id\}/);
  assert.match(payments, /kind: "duplicate"[\s\S]*failureCode: LATE_PAYMENT_REFUND_CODE/);
  assert.match(refunds, /payment\.kind NOT IN \('tip', 'duplicate'\)/);
  assert.match(payments, /refundLatePaymentBestEffort\(duplicate\.id, "duplicate_successful_payment_intent"\)/);
});

test("refund webhooks reconcile the pre-created idempotency row before inserting", () => {
  const recordRefund = payments.slice(payments.indexOf("export async function recordRefund"), payments.indexOf("export async function recordDispute"));
  assert.match(recordRefund, /sendascout_refund_key/);
  assert.match(recordRefund, /sendascout_refund_id/);
  assert.match(recordRefund, /const linkExistingRefund = async/);
  assert.match(recordRefund, /saved = await linkExistingRefund\(\)/);
  assert.match(recordRefund, /if \(!saved\) throw error/);
  assert.match(recordRefund, /await syncRefundedPayment\(payment\.id\)/);
});

test("case refunds reserve charge capacity before resolution and defer provider work until authorized", () => {
  const reserve = operations.indexOf("deferProcessing: true");
  const resolve = operations.indexOf("WITH ${lockedCaseCte}, ${lockedBundleCte}, locked_legs");
  assert.ok(reserve > 0 && resolve > reserve);
  assert.match(refunds, /if \(!input\.deferProcessing\)[\s\S]*processPaymentRefund/);
  assert.match(refunds, /authorized_case\.status = 'resolved'/);
  assert.match(operations, /active_dispute\.status NOT IN \('won', 'lost', 'prevented', 'warning_closed'\)/);
});

test("immediate cancellation attaches its deferred refund reservation before committing lifecycle state", () => {
  const cancellation = operations.slice(
    operations.indexOf("export async function openMissionCase"),
    operations.indexOf("export async function adminResolveMissionCase"),
  );
  const reserve = cancellation.indexOf("deferProcessing: true");
  const lifecycle = cancellation.indexOf("WITH active_leg AS");
  const attach = cancellation.indexOf("attached_refunds AS");
  const process = cancellation.lastIndexOf("requestMissionRefund");
  assert.ok(reserve > 0 && lifecycle > reserve && attach > lifecycle && process > attach);
  assert.match(cancellation, /mission_case_id = created_case\.id/);
  assert.match(cancellation, /refund\.mission_case_id IS NULL[\s\S]*refund\.stripe_refund_id IS NULL/);
  assert.match(cancellation, /cancellation_lifecycle_not_committed/);
  assert.match(cancellation, /isNull\(paymentRefunds\.missionCaseId\)[\s\S]*isNull\(paymentRefunds\.stripeRefundId\)/);
  assert.match(cancellation, /reason: refundReason/);
});

test("a competing provisional cancellation refund cannot produce a zero-refund cancellation", () => {
  const cancellation = operations.slice(
    operations.indexOf("export async function openMissionCase"),
    operations.indexOf("export async function adminResolveMissionCase"),
  );
  const conflictCheck = cancellation.indexOf("unlinkedMissionCaseReservationCents > 0");
  const refundAmount = cancellation.indexOf("const refundAmountCents");
  assert.ok(conflictCheck > 0 && refundAmount > conflictCheck);
  assert.match(refundCapacity, /unlinked_case_refund\.mission_case_id IS NULL/);
  assert.match(refundCapacity, /unlinked_case_refund\.status IN \('pending', 'requires_action'\)/);
  assert.match(refundCapacity, /unlinked_case_refund\.reason LIKE 'mission-case:%'/);
  assert.match(cancellation, /competing_refund\.id NOT IN/);
  assert.match(cancellation, /AND \$\{noCompetingCancellationReservation\}[\s\S]*RETURNING mission\.id/);
});

test("high-value discretionary refunds require a distinct second administrator", () => {
  assert.match(operations, /TWO_PERSON_REFUND_THRESHOLD_CENTS = 10_000/);
  assert.match(operations, /A different administrator must approve this high-value refund/);
  assert.match(support, /export async function adminApproveCustomerSupportRefund/);
  assert.match(support, /proposed_by <> \$\{admin\.id\}/);
  assert.match(support, /financial_approved_by = \$\{admin\.id\}/);
  assert.match(support, /ticket\.financialApprovedBy === ticket\.proposedBy/);
});

test("Support pauses work, links a case, and reserves a refund before closing", () => {
  const accept = support.slice(support.indexOf("export async function customerAcceptSupportResolution"));
  const casePosition = accept.indexOf("supportRefundMissionCase");
  const refundPosition = accept.indexOf("requestMissionRefund");
  const closePosition = accept.indexOf("SET status = 'closed'");
  assert.ok(casePosition > 0 && refundPosition > casePosition && closePosition > refundPosition);
  assert.match(accept, /missionCaseId,/);
  assert.match(accept, /refundResult\.refundFailedCents > 0/);
});

test("paid Control Room cancellation cannot bypass the case ledger", () => {
  assert.match(missionActions, /status === "cancelled"[\s\S]*\["authorized", "paid", "partially_refunded", "refunded", "disputed"\]\.includes\(effectivePaymentStatus\)/);
  assert.match(missionActions, /Paid bookings must be cancelled through a mission case/);
});
