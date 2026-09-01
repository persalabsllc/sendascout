import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const paymentsPage = readFileSync(new URL("../app/dashboard/customer/payments/page.tsx", import.meta.url), "utf8");
const paymentService = readFileSync(new URL("../lib/stripe-payments.ts", import.meta.url), "utf8");
const operations = readFileSync(new URL("../app/actions/operations.ts", import.meta.url), "utf8");
const missionActions = readFileSync(new URL("../app/actions/missions.ts", import.meta.url), "utf8");
const operationsCron = readFileSync(new URL("../app/api/cron/auto-complete/route.ts", import.meta.url), "utf8");

test("customer payment totals, entry count, empty state, and rows all use the visible ledger", () => {
  assert.match(paymentsPage, /missionStatus: missions\.status/);
  assert.match(paymentsPage, /const visibleLedger = ledger\.filter\(\(row\) => customerPaymentEntryIsVisible\(row\.missionStatus, row\.payment\)\)/);
  assert.match(paymentsPage, /const requestedCents = visibleLedger\.reduce/);
  assert.match(paymentsPage, /const collectedCents = visibleLedger\.filter/);
  assert.match(paymentsPage, /const attentionCents = visibleLedger\.filter/);
  assert.match(paymentsPage, /row\.missionStatus !== "cancelled" && recoverableStatuses\.has\(row\.payment\.status\)/);
  assert.match(paymentsPage, /note=\{`\$\{visibleLedger\.length\} payment entr/);
  assert.match(paymentsPage, /\{visibleLedger\.length \? <div className="mission-list">\{visibleLedger\.map/);
  assert.doesNotMatch(paymentsPage, /const requestedCents = ledger\./);
  assert.doesNotMatch(paymentsPage, /const attentionCents = ledger\./);
  assert.match(paymentsPage, /const canContinue = missionStatus !== "cancelled" && recoverableStatuses\.has\(payment\.status\)/);
});

test("cancelled booking cleanup expires only open Checkout and preserves payment evidence", () => {
  const cleanup = paymentService.slice(
    paymentService.indexOf("export async function cancelUncollectedBookingCheckout"),
    paymentService.indexOf("export async function reconcileCancelledMissionCheckouts"),
  );

  assert.match(cleanup, /scope\.mission\.status !== "cancelled"/);
  assert.match(cleanup, /!payableStatuses\.includes\(payment\.status\)[\s\S]*payment\.paidAt[\s\S]*payment\.stripeChargeId[\s\S]*payment\.refundedAmountCents > 0/);
  assert.match(cleanup, /session\.payment_status === "paid"[\s\S]*recordCheckoutSessionPaid\(session\)/);
  assert.match(cleanup, /session\.status === "open"[\s\S]*stripe\.checkout\.sessions\.expire\(session\.id\)/);
  assert.match(cleanup, /inArray\(payments\.status, payableStatuses\)[\s\S]*isNull\(payments\.paidAt\)[\s\S]*isNull\(payments\.stripeChargeId\)[\s\S]*eq\(payments\.refundedAmountCents, 0\)/);
  assert.match(cleanup, /failureCode: "mission_cancelled"/);
  assert.match(cleanup, /setBookingPaymentStatus\(cancelled, "canceled"\)/);
  assert.match(cleanup, /payment\.status === "processing"[\s\S]*payment\.failureCode === "checkout_creating"[\s\S]*!payment\.stripePaymentIntentId/);
});

test("cancelled missions cannot reopen an old hosted Checkout session", () => {
  const createCheckout = paymentService.slice(
    paymentService.indexOf("export async function createHostedCheckoutForPayment"),
    paymentService.indexOf("export async function recordCheckoutSessionPaid"),
  );
  const lifecycleGuard = createCheckout.indexOf('row.mission.archivedAt || row.mission.status === "cancelled"');
  const retrieveExistingSession = createCheckout.indexOf("stripe.checkout.sessions.retrieve");
  const claimStart = createCheckout.indexOf("const [claimed]");
  const claimEnd = createCheckout.indexOf("if (!claimed)");

  assert.ok(lifecycleGuard > 0);
  assert.ok(retrieveExistingSession > lifecycleGuard);
  assert.match(createCheckout, /row\.mission\.archivedAt \|\| row\.mission\.status === "cancelled"/);
  assert.match(createCheckout, /payment\.kind === "booking"[\s\S]*row\.mission\.status !== "draft"/);
  assert.match(createCheckout, /const lifecycleStillEligible = row\.payment\.kind === "booking"/);
  assert.match(createCheckout.slice(claimStart, claimEnd), /lifecycleStillEligible/);
  assert.match(createCheckout, /eq\(payments\.failureCode, "checkout_creating"\),[\s\S]*lifecycleStillEligible/);
  assert.match(createCheckout, /if \(!savedSession\)[\s\S]*recordCheckoutSessionPaid\(session\)[\s\S]*stripe\.checkout\.sessions\.expire\(session\.id\)[\s\S]*cancelUncollectedBookingCheckout\(row\.mission\.id\)/);
});

test("customer, case-resolution, and admin cancellation paths reconcile the uncollected booking", () => {
  const customerCancellation = operations.slice(
    operations.indexOf("export async function openMissionCase"),
    operations.indexOf("export async function adminResolveMissionCase"),
  );
  const caseResolution = operations.slice(operations.indexOf("export async function adminResolveMissionCase"));
  const adminStatus = missionActions.slice(missionActions.indexOf("export async function adminSetMissionStatus"));

  assert.match(operations, /import \{ cancelUncollectedBookingCheckout \} from "@\/lib\/stripe-payments"/);
  assert.match(customerCancellation, /immediateCancellation[\s\S]*cancelUncollectedBookingCheckout\(missionId\)/);
  assert.match(caseResolution, /resolution === "cancel"[\s\S]*cancelUncollectedBookingCheckout\(item\.mission\.id\)/);
  assert.match(missionActions, /import \{ cancelUncollectedBookingCheckout \} from "@\/lib\/stripe-payments"/);
  assert.match(adminStatus, /status === "cancelled"[\s\S]*cancelUncollectedBookingCheckout\(rootMission\.id\)/);
  assert.match(operations, /revalidatePath\("\/dashboard\/customer\/payments"\)/);
  assert.match(missionActions, /revalidatePath\("\/dashboard\/customer\/payments"\)/);
});

test("hourly recovery repairs existing cancelled Checkout rows", () => {
  const recovery = paymentService.slice(paymentService.indexOf("export async function reconcileCancelledMissionCheckouts"));

  assert.match(recovery, /eq\(missions\.status, "cancelled"\)/);
  assert.match(recovery, /inArray\(payments\.status, payableStatuses\)/);
  assert.match(recovery, /isNull\(payments\.paidAt\)/);
  assert.match(recovery, /isNull\(payments\.stripeChargeId\)/);
  assert.match(recovery, /eq\(payments\.livemode, getStripeLivemode\(\)\)/);
  assert.match(recovery, /cancelUncollectedBookingCheckout\(row\.id\)/);
  assert.match(operationsCron, /reconcileCancelledMissionCheckouts/);
  assert.match(operationsCron, /const cancelledCheckoutReconciliation = await reconcileCancelledMissionCheckouts\(\)/);
  assert.match(operationsCron, /cancelledCheckoutReconciliation/);
});
