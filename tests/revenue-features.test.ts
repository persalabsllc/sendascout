import assert from "node:assert/strict";
import test from "node:test";
import {
  hashDeliveryPin,
  isDeliveryPinLocked,
  isValidDeliveryPin,
  nextDeliveryPinFailureState,
  normalizeDeliveryPin,
  verifyDeliveryPin,
} from "../lib/delivery-pin.ts";
import {
  bundleStatusForLeg,
  calculateBundlePricing,
  canActivateBundleLeg,
  isFinalBundleLeg,
  isPrimaryMissionRow,
  nextBundleProgress,
  nextRecurrenceDate,
  recurrenceOccurrenceKey,
  shouldIncrementCompletedMissionCount,
} from "../lib/mission-features.ts";

test("delivery PINs are exactly six digits", () => {
  assert.equal(normalizeDeliveryPin(" 123456 "), "123456");
  assert.equal(isValidDeliveryPin("123456"), true);
  assert.equal(isValidDeliveryPin("12345"), false);
  assert.equal(isValidDeliveryPin("12A456"), false);
  assert.throws(() => normalizeDeliveryPin("12345"));
});

test("delivery PIN hashes are mission scoped and verify without plaintext storage", () => {
  const hash = hashDeliveryPin("123456", "test-pepper", "mission-one");
  assert.match(hash, /^hmac-sha256:[a-f0-9]{64}$/);
  assert.equal(verifyDeliveryPin("123456", hash, "test-pepper", "mission-one"), true);
  assert.equal(verifyDeliveryPin("654321", hash, "test-pepper", "mission-one"), false);
  assert.equal(verifyDeliveryPin("123456", hash, "wrong-pepper", "mission-one"), false);
  assert.equal(verifyDeliveryPin("123456", hash, "test-pepper", "mission-two"), false);
});

test("delivery PIN failures lock after five attempts for fifteen minutes", () => {
  const now = new Date("2026-08-30T20:00:00.000Z");
  assert.deepEqual(nextDeliveryPinFailureState(3, now), { failedAttempts: 4, lockedUntil: null });
  const locked = nextDeliveryPinFailureState(4, now);
  assert.equal(locked.failedAttempts, 5);
  assert.equal(locked.lockedUntil?.toISOString(), "2026-08-30T20:15:00.000Z");
  assert.equal(isDeliveryPinLocked(locked.lockedUntil, new Date("2026-08-30T20:14:59.999Z")), true);
  assert.equal(isDeliveryPinLocked(locked.lockedUntil, new Date("2026-08-30T20:15:00.000Z")), false);
});

test("bundle discounts never reduce Scout compensation or create a negative platform fee", () => {
  const price = calculateBundlePricing([
    { customerPriceCents: 2900, scoutPayoutCents: 2000 },
    { customerPriceCents: 1900, scoutPayoutCents: 1000 },
  ], 400);
  assert.deepEqual(price, {
    listCustomerPriceCents: 4800,
    bundleDiscountCents: 400,
    customerPriceCents: 4400,
    scoutPayoutCents: 3000,
    platformFeeCents: 1400,
  });

  const capped = calculateBundlePricing([{ customerPriceCents: 1900, scoutPayoutCents: 1000 }], 5000);
  assert.equal(capped.bundleDiscountCents, 900);
  assert.equal(capped.customerPriceCents, 1000);
  assert.equal(capped.platformFeeCents, 0);
});

test("only the bundle root is eligible for ordinary mission listings", () => {
  assert.equal(isPrimaryMissionRow(null, null), true);
  assert.equal(isPrimaryMissionRow("bundle", 1), true);
  assert.equal(isPrimaryMissionRow("bundle", 2), false);
});

test("only a legacy mission or final bundle leg increments completed mission count", () => {
  assert.equal(isFinalBundleLeg(null, null, null), true);
  assert.equal(isFinalBundleLeg("bundle", 1, 2), false);
  assert.equal(isFinalBundleLeg("bundle", 2, 2), true);
  assert.equal(shouldIncrementCompletedMissionCount("bundle", 1, 2), false);
  assert.equal(shouldIncrementCompletedMissionCount("bundle", 2, 2), true);
});

test("bundle legs unlock in order and finish at final submission", () => {
  assert.equal(canActivateBundleLeg({ activeSequence: 1, legSequence: 1 }), true);
  assert.equal(canActivateBundleLeg({ activeSequence: 2, legSequence: 2, predecessorStatus: "submitted" }), true);
  assert.equal(canActivateBundleLeg({ activeSequence: 2, legSequence: 2, predecessorStatus: "onsite" }), false);
  assert.deepEqual(nextBundleProgress(1, 2), { activeSequence: 2, status: "in_progress" });
  assert.deepEqual(nextBundleProgress(2, 2), { activeSequence: 2, status: "submitted" });
  assert.equal(bundleStatusForLeg("at_dropoff", true), "in_progress");
  assert.equal(bundleStatusForLeg("submitted", true), "submitted");
  assert.equal(bundleStatusForLeg("completed", true), "completed");
});

test("supported recurrence rules produce deterministic next dates", () => {
  const start = new Date("2026-08-30T20:00:00.000Z");
  assert.equal(nextRecurrenceDate(start, "FREQ=DAILY;INTERVAL=2").toISOString(), "2026-09-01T20:00:00.000Z");
  assert.equal(nextRecurrenceDate(start, "FREQ=WEEKLY").toISOString(), "2026-09-06T20:00:00.000Z");
  assert.equal(nextRecurrenceDate(start, "FREQ=MONTHLY").toISOString(), "2026-09-30T20:00:00.000Z");
  assert.equal(nextRecurrenceDate(new Date("2027-01-31T20:00:00.000Z"), "FREQ=MONTHLY").toISOString(), "2027-02-28T20:00:00.000Z");
  assert.equal(recurrenceOccurrenceKey("schedule-1", start), "schedule-1:2026-08-30T20:00:00.000Z");
  assert.throws(() => nextRecurrenceDate(start, "FREQ=HOURLY"));
});
