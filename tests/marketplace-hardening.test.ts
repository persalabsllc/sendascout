import assert from "node:assert/strict";
import test from "node:test";
import {
  cancellationMode,
  bundledCancellationMode,
  bundleStatusAfterResolution,
  caseResolutionIsFinal,
  caseKindAllowed,
  missionStatusAfterResolution,
  remainingCaseAdjustmentCents,
} from "../lib/mission-operations.ts";
import { meetActionIsAvailable, meetActionOpensAt } from "../lib/mission-timing.ts";
import { SCOUT_HANDBOOK_VERSION } from "../lib/scout-handbook.ts";
import { scoutApprovalChecklist, scoutReadyForApproval, type ScoutApprovalInput } from "../lib/scout-approval.ts";
import { scoutConnectReady } from "../lib/stripe-connect.ts";

test("unstarted missions cancel immediately", () => {
  for (const status of ["draft", "open", "claimed"] as const) assert.equal(cancellationMode(status), "immediate");
});

test("work in progress requires Control Room review", () => {
  for (const status of ["en_route", "onsite", "en_route_pickup", "at_pickup", "en_route_dropoff", "at_dropoff", "submitted", "disputed"] as const) {
    assert.equal(cancellationMode(status), "review");
  }
});

test("finished missions cannot use the cancellation path", () => {
  assert.equal(cancellationMode("completed"), "unavailable");
  assert.equal(cancellationMode("cancelled"), "unavailable");
});

test("a later bundle leg cannot erase completed work through immediate cancellation", () => {
  assert.equal(bundledCancellationMode("claimed", 1), "immediate");
  assert.equal(bundledCancellationMode("claimed", 2), "review");
});

test("customer and Scout case types are role restricted", () => {
  assert.equal(caseKindAllowed("customer", "customer_problem"), true);
  assert.equal(caseKindAllowed("customer", "scout_safety_concern"), false);
  assert.equal(caseKindAllowed("scout", "scout_customer_no_show"), true);
  assert.equal(caseKindAllowed("scout", "customer_cancellation"), false);
  assert.equal(caseKindAllowed("admin", "scout_safety_concern"), true);
});

test("case resolutions produce explicit mission states", () => {
  assert.equal(missionStatusAfterResolution("cancel", "en_route"), "cancelled");
  assert.equal(missionStatusAfterResolution("complete", "submitted"), "completed");
  assert.equal(missionStatusAfterResolution("hold", "claimed"), "disputed");
  assert.equal(missionStatusAfterResolution("resume", "at_pickup"), "at_pickup");
});

test("bundle case resolutions restore the aggregate lifecycle", () => {
  assert.equal(bundleStatusAfterResolution("resume", "claimed", 1), "claimed");
  assert.equal(bundleStatusAfterResolution("resume", "at_dropoff", 2), "in_progress");
  assert.equal(bundleStatusAfterResolution("hold", "at_dropoff", 2), "disputed");
  assert.equal(bundleStatusAfterResolution("cancel", "at_dropoff", 2), "cancelled");
});

test("keep-paused is a review update rather than a final case resolution", () => {
  assert.equal(caseResolutionIsFinal("hold"), false);
  for (const resolution of ["resume", "cancel", "complete"] as const) {
    assert.equal(caseResolutionIsFinal(resolution), true);
  }
});

test("case adjustments cannot exceed the remaining mission balance", () => {
  assert.equal(remainingCaseAdjustmentCents(10_000, 2_500), 7_500);
  assert.equal(remainingCaseAdjustmentCents(10_000, 10_000), 0);
  assert.equal(remainingCaseAdjustmentCents(10_000, 12_000), 0);
});

test("Meet It travel opens exactly 30 minutes early", () => {
  const scheduled = new Date("2026-08-30T20:00:00.000Z");
  assert.equal(meetActionOpensAt(scheduled, "en_route").toISOString(), "2026-08-30T19:30:00.000Z");
  assert.equal(meetActionIsAvailable(scheduled, "en_route", new Date("2026-08-30T19:29:59.999Z")), false);
  assert.equal(meetActionIsAvailable(scheduled, "en_route", new Date("2026-08-30T19:30:00.000Z")), true);
});

test("Meet It verified check-in opens exactly five minutes early", () => {
  const scheduled = new Date("2026-08-30T20:00:00.000Z");
  assert.equal(meetActionOpensAt(scheduled, "onsite").toISOString(), "2026-08-30T19:55:00.000Z");
  assert.equal(meetActionIsAvailable(scheduled, "onsite", new Date("2026-08-30T19:54:59.999Z")), false);
  assert.equal(meetActionIsAvailable(scheduled, "onsite", new Date("2026-08-30T19:55:00.000Z")), true);
});

const readyScout: ScoutApprovalInput = {
  firstName: "Kyle",
  lastName: "Scout",
  phone: "252-555-0100",
  legalVersion: "current",
  handbookVersion: SCOUT_HANDBOOK_VERSION,
  handbookAcceptedAt: new Date(),
  identityCheck: "clear",
  identityVerifiedName: "Kyle Scout",
  identityVerifiedAt: new Date(),
  headshotPath: "scout-headshots/upload/kyle.webp",
  homeZip: "28562",
  vehicleType: "Car",
  canSee: true,
  canMove: true,
  canMeet: true,
  verificationConsentedAt: new Date(),
  stripeAccountId: "acct_test_scout",
  stripeAccountLivemode: false,
  stripeConnectStatus: "ready",
  stripeTransfersActive: true,
  payoutsEnabled: true,
  stripePayoutScheduleConfiguredAt: new Date(),
};

test("Scout approval requires every trust and profile check", () => {
  assert.equal(scoutReadyForApproval(readyScout, "current", false), true);
  const incomplete = { ...readyScout, headshotPath: null, identityCheck: "pending", legalVersion: "old" };
  assert.equal(scoutReadyForApproval(incomplete, "current", false), false);
  assert.deepEqual(scoutApprovalChecklist(incomplete, "current", false).filter((item) => !item.complete).map((item) => item.key), ["identity", "terms", "headshot"]);
});

test("Scout approval requires the current handbook acknowledgement", () => {
  const incomplete = { ...readyScout, handbookVersion: "2026-08-01-v0", handbookAcceptedAt: new Date() };
  assert.equal(scoutReadyForApproval(incomplete, "current", false), false);
  assert.deepEqual(scoutApprovalChecklist(incomplete, "current", false).filter((item) => !item.complete).map((item) => item.key), ["handbook"]);

  const missingTimestamp = { ...readyScout, handbookAcceptedAt: null };
  assert.equal(scoutReadyForApproval(missingTimestamp, "current", false), false);
  assert.deepEqual(scoutApprovalChecklist(missingTimestamp, "current", false).filter((item) => !item.complete).map((item) => item.key), ["handbook"]);
});

test("Scout approval requires a transfer-ready Stripe account", () => {
  const incomplete = { ...readyScout, stripeTransfersActive: false, payoutsEnabled: false };
  assert.equal(scoutReadyForApproval(incomplete, "current", false), false);
  assert.deepEqual(scoutApprovalChecklist(incomplete, "current", false).filter((item) => !item.complete).map((item) => item.key), ["payouts"]);
});

test("Scout approval waits for the Friday payout schedule", () => {
  const incomplete = { ...readyScout, stripePayoutScheduleConfiguredAt: null };
  assert.equal(scoutReadyForApproval(incomplete, "current", false), false);
  assert.deepEqual(scoutApprovalChecklist(incomplete, "current", false).filter((item) => !item.complete).map((item) => item.key), ["payouts"]);
});

test("Scout approval waits while Stripe reports a restricted account", () => {
  const incomplete = { ...readyScout, stripeConnectStatus: "restricted" };
  assert.equal(scoutReadyForApproval(incomplete, "current", false), false);
  assert.deepEqual(scoutApprovalChecklist(incomplete, "current", false).filter((item) => !item.complete).map((item) => item.key), ["payouts"]);
});

test("Scout approval rejects a payout account from the other Stripe mode", () => {
  assert.equal(scoutReadyForApproval(readyScout, "current", true), false);
  assert.deepEqual(scoutApprovalChecklist(readyScout, "current", true).filter((item) => !item.complete).map((item) => item.key), ["payouts"]);
});

test("Stripe Connect readiness requires the current Stripe mode", () => {
  assert.equal(scoutConnectReady(readyScout, false), true);
  assert.equal(scoutConnectReady(readyScout, true), false);
  assert.equal(scoutConnectReady({ ...readyScout, stripeAccountLivemode: null }, false), false);
});

test("a fake or incomplete profile cannot pass approval", () => {
  const incomplete = { ...readyScout, firstName: "", lastName: null, phone: "555", homeZip: "ABCDE", vehicleType: "", canSee: false, canMove: false, canMeet: false, verificationConsentedAt: null };
  assert.equal(scoutReadyForApproval(incomplete, "current", false), false);
  assert.ok(scoutApprovalChecklist(incomplete, "current", false).filter((item) => !item.complete).length >= 6);
});
