import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  paymentStatusAfterDisputes,
  stripeDisputeBlocksPayment,
  stripeDisputeIsClosed,
} from "../lib/stripe-dispute-core.ts";

const lifecycleService = readFileSync(new URL("../lib/stripe-dispute-lifecycle.ts", import.meta.url), "utf8");
const paymentService = readFileSync(new URL("../lib/stripe-payments.ts", import.meta.url), "utf8");
const webhookService = readFileSync(new URL("../lib/stripe-webhooks.ts", import.meta.url), "utf8");

test("only provider outcomes without a loss release the payment dispute hold", () => {
  for (const status of ["needs_response", "under_review", "warning_needs_response", "warning_under_review", "lost"]) {
    assert.equal(stripeDisputeBlocksPayment(status), true, status);
  }
  assert.equal(stripeDisputeBlocksPayment("won"), false);
  assert.equal(stripeDisputeBlocksPayment("prevented"), false);
  assert.equal(stripeDisputeBlocksPayment("warning_closed"), false);
  assert.equal(stripeDisputeIsClosed("won"), true);
  assert.equal(stripeDisputeIsClosed("lost"), true);
  assert.equal(stripeDisputeIsClosed("prevented"), true);
  assert.equal(stripeDisputeIsClosed("warning_closed"), true);
  assert.equal(stripeDisputeIsClosed("under_review"), false);
});

test("aggregate payment state cannot be released while any dispute still blocks it", () => {
  assert.equal(paymentStatusAfterDisputes(["won", "under_review"], 0, 10_000), "disputed");
  assert.equal(paymentStatusAfterDisputes(["won", "lost"], 0, 10_000), "disputed");
  assert.equal(paymentStatusAfterDisputes(["won", "warning_closed"], 0, 10_000), "paid");
  assert.equal(paymentStatusAfterDisputes(["won"], 2_500, 10_000), "partially_refunded");
  assert.equal(paymentStatusAfterDisputes(["warning_closed"], 10_000, 10_000), "refunded");
});

test("dispute lifecycle creates a serialized Control Room pause without automatic clawback", () => {
  assert.match(lifecycleService, /client\.transaction/);
  assert.match(lifecycleService, /isolationLevel: "Serializable"/);
  assert.match(lifecycleService, /'stripe_payment_dispute'/);
  assert.match(lifecycleService, /SET status = 'disputed'/);
  assert.match(lifecycleService, /POSITION\(\$\{identityMarker\}/);
  assert.match(lifecycleService, /No Scout transfer reversal was created automatically/);
  assert.doesNotMatch(lifecycleService, /createReversal|paymentTransferReversals|reverseScoutTransfer/);
  assert.doesNotMatch(lifecycleService, /db\.transaction\(async/);
});

test("dispute persistence serializes per payment and webhooks fetch canonical provider state", () => {
  assert.match(paymentService, /provider_event_created_at/);
  assert.match(paymentService, /EXCLUDED\.provider_event_created_at > payment_disputes\.provider_event_created_at/);
  assert.match(paymentService, /'won', 'lost', 'prevented', 'warning_closed'/);
  assert.match(paymentService, /isolationLevel: "Serializable"/);
  assert.match(paymentService, /await syncRefundedPayment\(updated\.payment_id\);[\s\S]*await reconcileStripeDisputeMissionLifecycle/);
  assert.match(paymentService, /reconcileStripeDisputeMissionLifecycle/);
  assert.match(webhookService, /disputes\.retrieve\(incoming\.id, \{ expand: \["payment_intent"\] \}\)/);
  assert.match(webhookService, /new Date\(event\.created \* 1000\)/);
});

test("webhook claims are compare-and-set and unmatched app disputes are retried", () => {
  assert.match(webhookService, /returning\(\{ attemptCount: stripeWebhookEvents\.attemptCount \}\)/);
  assert.match(webhookService, /eq\(stripeWebhookEvents\.attemptCount, claimed\.attemptCount\)/);
  assert.match(webhookService, /is already being processed/);
  assert.match(webhookService, /arrived before its Send a Scout payment could be linked/);
});
