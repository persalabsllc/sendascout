import assert from "node:assert/strict";
import test from "node:test";
import {
  hashDeliveryPin,
  isDeliveryPinLocked,
  nextDeliveryPinFailureState,
  normalizeDeliveryPin,
  verifyDeliveryPin,
} from "../lib/delivery-pin.ts";
import {
  bundleStatusForLeg,
  calculateBundlePricing,
  canActivateBundleLeg,
  recurrenceOccurrenceKey,
  nextBundleProgress,
  nextRecurrenceDate,
  shouldIncrementCompletedMissionCount,
} from "../lib/mission-features.ts";
import {
  isVerifiedDeliveryPhoto,
  MAX_MISSION_EVIDENCE_BYTES,
} from "../lib/mission-evidence.ts";
import { calculateLegacyMissionAmounts } from "../lib/mission-pricing-core.ts";

test("a Meet It plus Move It bundle discounts the customer without reducing Scout pay", () => {
  const meet = calculateLegacyMissionAmounts("meet");
  const move = calculateLegacyMissionAmounts("move", 3);
  const bundle = calculateBundlePricing([
    { customerPriceCents: meet.customerPriceCents, scoutPayoutCents: meet.scoutPayoutCents },
    { customerPriceCents: move.customerPriceCents, scoutPayoutCents: move.scoutPayoutCents },
  ], 400);

  assert.deepEqual(bundle, {
    listCustomerPriceCents: 4800,
    bundleDiscountCents: 400,
    customerPriceCents: 4400,
    scoutPayoutCents: 3000,
    platformFeeCents: 1400,
  });
});

test("bundle pricing rejects malformed money and an underfunded Scout payout", () => {
  assert.throws(() => calculateBundlePricing([]), /at least one mission/i);
  assert.throws(
    () => calculateBundlePricing([{ customerPriceCents: 999, scoutPayoutCents: 1000 }]),
    /cannot be lower/i,
  );
  assert.throws(
    () => calculateBundlePricing([{ customerPriceCents: 1900.5, scoutPayoutCents: 1000 }]),
    /whole-cent/i,
  );
  assert.throws(
    () => calculateBundlePricing([{ customerPriceCents: 1900, scoutPayoutCents: 1000 }], -1),
    /nonnegative/i,
  );
});

test("delivery PIN hashing preserves leading zeros and rejects malformed stored hashes", () => {
  assert.equal(normalizeDeliveryPin("004219"), "004219");
  const storedHash = hashDeliveryPin("004219", "pepper", "mission-id");
  assert.equal(verifyDeliveryPin("004219", storedHash, "pepper", "mission-id"), true);
  assert.equal(verifyDeliveryPin("4219", storedHash, "pepper", "mission-id"), false);
  assert.equal(verifyDeliveryPin("004219", "hmac-sha256:not-a-digest", "pepper", "mission-id"), false);
  assert.equal(verifyDeliveryPin("004219", "plaintext", "pepper", "mission-id"), false);
  assert.throws(() => hashDeliveryPin("004219", "", "mission-id"), /pepper is required/i);
  assert.throws(() => hashDeliveryPin("004219", "pepper", " "), /mission id is required/i);
});

test("delivery PIN lock behavior is exact at the attempt and time boundaries", () => {
  const now = new Date("2026-08-30T20:00:00.000Z");
  const fourthFailure = nextDeliveryPinFailureState(3, now);
  assert.deepEqual(fourthFailure, { failedAttempts: 4, lockedUntil: null });

  const fifthFailure = nextDeliveryPinFailureState(4, now);
  assert.equal(fifthFailure.failedAttempts, 5);
  assert.equal(fifthFailure.lockedUntil?.toISOString(), "2026-08-30T20:15:00.000Z");
  assert.equal(isDeliveryPinLocked(fifthFailure.lockedUntil, new Date("2026-08-30T20:14:59.999Z")), true);
  assert.equal(isDeliveryPinLocked(fifthFailure.lockedUntil, new Date("2026-08-30T20:15:00.000Z")), false);
  assert.equal(isDeliveryPinLocked(null, now), false);
  assert.throws(() => nextDeliveryPinFailureState(-1, now), /invalid/i);
});

test("a two-leg bundle exposes only its active leg and reaches a terminal state once", () => {
  assert.equal(canActivateBundleLeg({ activeSequence: 1, legSequence: 2, predecessorStatus: "submitted" }), false);
  assert.equal(canActivateBundleLeg({ activeSequence: 2, legSequence: 1 }), false);
  assert.deepEqual(nextBundleProgress(1, 2), { activeSequence: 2, status: "in_progress" });
  assert.equal(bundleStatusForLeg("completed", false), "in_progress");
  assert.equal(shouldIncrementCompletedMissionCount("bundle-id", 1, 2), false);
  assert.deepEqual(nextBundleProgress(2, 2), { activeSequence: 2, status: "submitted" });
  assert.equal(bundleStatusForLeg("completed", true), "completed");
  assert.equal(shouldIncrementCompletedMissionCount("bundle-id", 2, 2), true);
  assert.equal(shouldIncrementCompletedMissionCount(null, null, null), true);
  assert.throws(() => nextBundleProgress(3, 2), /invalid/i);
});

test("recurrence intervals are deterministic and preserve the original input", () => {
  const occurrence = new Date("2026-08-30T20:00:00.000Z");
  const original = occurrence.toISOString();
  assert.equal(
    nextRecurrenceDate(occurrence, "FREQ=WEEKLY;INTERVAL=2").toISOString(),
    "2026-09-13T20:00:00.000Z",
  );
  assert.equal(occurrence.toISOString(), original);
  assert.equal(
    nextRecurrenceDate(new Date("2027-01-31T20:00:00.000Z"), "FREQ=MONTHLY").toISOString(),
    "2027-02-28T20:00:00.000Z",
  );
  const monthlyAnchor = new Date("2027-01-31T20:00:00.000Z");
  const februaryOccurrence = nextRecurrenceDate(monthlyAnchor, "FREQ=MONTHLY", { anchor: monthlyAnchor });
  assert.equal(
    nextRecurrenceDate(februaryOccurrence, "FREQ=MONTHLY", { anchor: monthlyAnchor }).toISOString(),
    "2027-03-31T19:00:00.000Z",
  );
  assert.equal(
    nextRecurrenceDate(new Date("2026-03-01T21:00:00.000Z"), "FREQ=WEEKLY").toISOString(),
    "2026-03-08T20:00:00.000Z",
  );
  const occurrenceKey = recurrenceOccurrenceKey("recurrence-1", occurrence);
  assert.equal(occurrenceKey, "recurrence-1:2026-08-30T20:00:00.000Z");
  assert.equal(recurrenceOccurrenceKey("recurrence-1", new Date(occurrence)), occurrenceKey);
  assert.notEqual(recurrenceOccurrenceKey("recurrence-2", occurrence), occurrenceKey);
  assert.throws(() => recurrenceOccurrenceKey(" ", occurrence), /invalid/i);
  assert.throws(() => nextRecurrenceDate(new Date("invalid"), "FREQ=WEEKLY"), /invalid/i);
  assert.throws(() => nextRecurrenceDate(occurrence, "FREQ=WEEKLY;INTERVAL=0"), /interval/i);
  assert.throws(() => nextRecurrenceDate(occurrence, "FREQ=WEEKLY;INTERVAL=1.5"), /interval/i);
});

test("proof of delivery requires semantic delivery-photo evidence and a verified image MIME", () => {
  for (const contentType of ["image/jpeg", "image/png", "image/webp"] as const) {
    assert.equal(isVerifiedDeliveryPhoto({
      kind: "delivery_photo",
      contentType,
      byteSize: 512,
    }), true);
  }

  assert.equal(isVerifiedDeliveryPhoto({
    kind: "general_result",
    contentType: "image/jpeg",
    byteSize: 512,
  }), false);
  assert.equal(isVerifiedDeliveryPhoto({
    kind: "delivery_photo",
    contentType: "video/mp4",
    byteSize: 512,
  }), false);
  assert.equal(isVerifiedDeliveryPhoto({
    kind: "delivery_photo",
    contentType: "image/svg+xml",
    byteSize: 512,
  }), false);
  assert.equal(isVerifiedDeliveryPhoto({
    kind: "delivery_photo",
    contentType: "image/jpeg",
    byteSize: 0,
  }), false);
  assert.equal(isVerifiedDeliveryPhoto({
    kind: "delivery_photo",
    contentType: "image/jpeg",
    byteSize: MAX_MISSION_EVIDENCE_BYTES + 1,
  }), false);
});
