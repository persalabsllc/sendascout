import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const missionActions = readFileSync(new URL("../app/actions/missions.ts", import.meta.url), "utf8");
const addons = readFileSync(new URL("../lib/stripe-payment-addons.ts", import.meta.url), "utf8");
const hourlyOperations = readFileSync(new URL("../app/api/cron/auto-complete/route.ts", import.meta.url), "utf8");

test("customer confirmation reads Neon rows and verifies every atomic write", () => {
  const confirmation = missionActions.slice(
    missionActions.indexOf("export async function confirmMissionComplete"),
    missionActions.indexOf("export async function setPreferredScoutFromMission"),
  );

  assert.match(confirmation, /execute<\{ id: string; review_id: string; tip_payment_id: string \| null \}>/);
  assert.match(confirmation, /completion = completedResult\.rows\[0\]/);
  assert.match(confirmation, /COUNT\(\*\) FROM accepted_result\) = 1/);
  assert.match(confirmation, /COUNT\(\*\) FROM saved_review\) = 1/);
  assert.match(confirmation, /COUNT\(\*\) FROM updated_scout\) = 1/);
  assert.match(confirmation, /COUNT\(\*\) FROM saved_tip_payment\) = \$\{tipCents > 0 \? 1 : 0\}/);
  assert.match(confirmation, /booking\.customer_id = saved_review\.customer_id/);
  assert.match(confirmation, /booking\.stripe_customer_id IS NOT NULL/);
  assert.match(confirmation, /booking\.stripe_payment_intent_id IS NOT NULL/);
  assert.match(confirmation, /booking\.livemode = \$\{getStripeLivemode\(\)\}/);
  assert.match(confirmation, /booking\.currency = 'usd'/);
  assert.match(confirmation, /databaseCode: code \?\? "unknown"/);
  assert.match(confirmation, /if \(code === "22012"\)/);
  assert.match(confirmation, /Mission confirmation notification could not be queued/);
});

test("hourly operations safely resumes committed but unstarted tip payments", () => {
  const recovery = addons.slice(
    addons.indexOf("export async function reconcilePendingTipPayments"),
    addons.indexOf("async function reconcileAttemptIntent"),
  );

  assert.match(recovery, /eq\(payments\.kind, "tip"\)/);
  assert.match(recovery, /eq\(payments\.status, "pending"\)/);
  assert.match(recovery, /isNull\(payments\.stripePaymentIntentId\)/);
  assert.match(recovery, /isNull\(payments\.stripeCheckoutSessionId\)/);
  assert.match(recovery, /gt\(payments\.createdAt, oldest\)/);
  assert.match(recovery, /eq\(missions\.status, "completed"\)/);
  assert.match(recovery, /eq\(missionReviews\.tipStatus, "pending"\)/);
  assert.match(recovery, /eq\(payments\.scoutPayoutCents, payments\.amountCents\)/);
  assert.match(recovery, /eq\(payments\.platformFeeCents, 0\)/);
  assert.match(recovery, /const result = await attemptSavedPayment\(row\.id\)/);
  assert.match(recovery, /kind: `tip_payment_required:\$\{row\.id\}`/);

  const pendingIndex = hourlyOperations.indexOf("await reconcilePendingTipPayments()");
  const ambiguousIndex = hourlyOperations.indexOf("await reconcileAmbiguousOffSessionPayments()");
  assert.ok(pendingIndex > 0, "the hourly worker must invoke pending-tip recovery");
  assert.ok(ambiguousIndex > pendingIndex, "new tip attempts must start before ambiguous attempts are reconciled");
});
