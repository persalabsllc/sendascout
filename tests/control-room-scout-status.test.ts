import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  nextScoutOnboardingStep,
  scoutStripeReadinessChecklist,
  type ScoutApprovalInput,
} from "../lib/scout-approval.ts";
import { SCOUT_HANDBOOK_VERSION } from "../lib/scout-handbook.ts";

function source(relativePath: string) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

const stripeActions = source("app/actions/stripe-connect.ts");
const stripeConnectService = source("lib/stripe-connect-service.ts");
const controlRoomPage = source("app/control-room/scouts/page.tsx");
const controlRoomScouts = source("components/control-room-scouts.tsx");
const scoutPayoutAccount = source("components/scout-payout-account.tsx");
const scoutOnboarding = source("components/onboarding-form.tsx");
const homepage = source("app/page.tsx");

const currentLegalVersion = "current";
const readyScout: ScoutApprovalInput = {
  firstName: "Ready",
  lastName: "Scout",
  phone: "252-555-0100",
  legalVersion: currentLegalVersion,
  legalAcceptedAt: new Date("2026-09-01T12:00:00.000Z"),
  handbookVersion: SCOUT_HANDBOOK_VERSION,
  handbookAcceptedAt: new Date("2026-09-01T12:00:00.000Z"),
  identityCheck: "clear",
  identityProvider: "stripe_connect_v2",
  identityVerificationReference: "person_ready",
  identityVerifiedName: "Ready Scout",
  identityVerifiedAt: new Date("2026-09-01T12:00:00.000Z"),
  identityVerifiedBy: null,
  headshotPath: "scout-headshots/ready.webp",
  homeZip: "28562",
  serviceRadiusMiles: 25,
  vehicleType: "Car",
  canSee: true,
  canMove: true,
  canMeet: true,
  verificationConsentedAt: new Date("2026-09-01T12:00:00.000Z"),
  stripeAccountId: "acct_ready",
  stripeAccountApiVersion: "v2",
  stripeAccountLivemode: true,
  stripeConnectStatus: "ready",
  stripeDetailsSubmitted: true,
  stripeTransfersActive: true,
  payoutsEnabled: true,
  stripeRequirementsCurrentlyDue: [],
  stripeRequirementsPastDue: [],
  stripeRequirementsPendingVerification: [],
  stripeOnboardingCompletedAt: new Date("2026-09-01T12:00:00.000Z"),
  stripePayoutScheduleConfiguredAt: new Date("2026-09-01T12:00:00.000Z"),
  stripeSyncGeneration: 0,
  stripeSyncCompletedGeneration: 0,
};

function stateMap(input: ScoutApprovalInput) {
  return Object.fromEntries(scoutStripeReadinessChecklist(input, true).map((item) => [item.key, item.state]));
}

test("Control Room Stripe diagnostics distinguish every operational readiness layer", () => {
  assert.deepEqual(stateMap(readyScout), {
    account: "complete",
    mode: "complete",
    details: "complete",
    verification: "complete",
    capabilities: "complete",
    schedule: "complete",
  });

  assert.deepEqual(stateMap({
    ...readyScout,
    stripeAccountId: null,
    stripeAccountLivemode: null,
    stripeConnectStatus: "not_started",
    stripeDetailsSubmitted: false,
    stripeTransfersActive: false,
    payoutsEnabled: false,
    stripePayoutScheduleConfiguredAt: null,
  }), {
    account: "missing",
    mode: "missing",
    details: "missing",
    verification: "missing",
    capabilities: "missing",
    schedule: "missing",
  });

  const reviewing = stateMap({
    ...readyScout,
    stripeConnectStatus: "pending",
    stripeTransfersActive: false,
    payoutsEnabled: false,
    stripeRequirementsPendingVerification: ["Identity document"],
    stripePayoutScheduleConfiguredAt: null,
  });
  assert.equal(reviewing.verification, "pending");
  assert.equal(reviewing.capabilities, "pending");
  assert.equal(reviewing.schedule, "pending");

  const restricted = stateMap({
    ...readyScout,
    stripeConnectStatus: "restricted",
    stripeTransfersActive: false,
    payoutsEnabled: false,
    stripeRequirementsCurrentlyDue: ["Bank account"],
    stripePayoutScheduleConfiguredAt: null,
  });
  assert.equal(restricted.verification, "action_required");
  assert.equal(restricted.capabilities, "action_required");

  const wrongMode = stateMap({ ...readyScout, stripeAccountLivemode: false });
  assert.equal(wrongMode.account, "complete");
  assert.equal(wrongMode.mode, "action_required");
});

test("Friday readiness is automatic system verification rather than Scout consent", () => {
  const schedule = scoutStripeReadinessChecklist({
    ...readyScout,
    stripePayoutScheduleConfiguredAt: null,
  }, true).find((item) => item.key === "schedule");

  assert.deepEqual(schedule, {
    key: "schedule",
    label: "Automatic weekly Friday payout schedule verified",
    state: "pending",
    detail: "Configured automatically by Send a Scout; no Scout action is required.",
  });

  assert.match(scoutPayoutAccount, /const schedulePending = props\.status === "ready"/);
  assert.match(scoutPayoutAccount, /No action is required from you while this finishes\./);
  assert.match(scoutPayoutAccount, /!schedulePending && !showAccountChoice/);
  assert.doesNotMatch(`${homepage}\n${scoutOnboarding}`, /same-day payout/i);
  assert.match(homepage, /secure weekly payouts through Stripe/i);
  assert.match(scoutOnboarding, /Secure weekly payouts through Stripe/);
});

test("next-step guidance prioritizes Scout work before Control Room review", () => {
  const incompleteProfile = nextScoutOnboardingStep({
    ...readyScout,
    phone: null,
    headshotPath: null,
    handbookVersion: null,
    handbookAcceptedAt: null,
    stripeAccountId: null,
    stripeAccountLivemode: null,
    stripeConnectStatus: "not_started",
    stripeDetailsSubmitted: false,
    stripeTransfersActive: false,
    payoutsEnabled: false,
    stripePayoutScheduleConfiguredAt: null,
    identityCheck: "not_started",
    identityVerifiedName: null,
    identityVerifiedAt: null,
  }, currentLegalVersion, true, "applicant");
  assert.equal(incompleteProfile.key, "profile");
  assert.equal(incompleteProfile.owner, "scout");
  assert.match(incompleteProfile.label, /mobile number/);
  assert.match(incompleteProfile.label, /profile headshot/);

  const handbook = nextScoutOnboardingStep({
    ...readyScout,
    handbookVersion: null,
    handbookAcceptedAt: null,
    stripeAccountId: null,
    stripeAccountLivemode: null,
    stripeConnectStatus: "not_started",
    stripeDetailsSubmitted: false,
    stripeTransfersActive: false,
    payoutsEnabled: false,
    stripePayoutScheduleConfiguredAt: null,
    identityCheck: "not_started",
    identityVerifiedName: null,
    identityVerifiedAt: null,
  }, currentLegalVersion, true, "applicant");
  assert.equal(handbook.key, "handbook");
  assert.equal(handbook.owner, "scout");

  const stripeReview = nextScoutOnboardingStep({
    ...readyScout,
    stripeConnectStatus: "pending",
    stripeTransfersActive: false,
    payoutsEnabled: false,
    stripeRequirementsPendingVerification: ["Identity document"],
    stripePayoutScheduleConfiguredAt: null,
    identityCheck: "not_started",
    identityVerifiedName: null,
    identityVerifiedAt: null,
  }, currentLegalVersion, true, "applicant");
  assert.equal(stripeReview.key, "payouts");
  assert.equal(stripeReview.owner, "stripe");

  const scheduleReview = nextScoutOnboardingStep({
    ...readyScout,
    stripePayoutScheduleConfiguredAt: null,
    identityCheck: "not_started",
    identityVerifiedName: null,
    identityVerifiedAt: null,
  }, currentLegalVersion, true, "applicant");
  assert.equal(scheduleReview.key, "payouts");
  assert.equal(scheduleReview.owner, "system");

  const identityReview = nextScoutOnboardingStep({
    ...readyScout,
    identityCheck: "not_started",
    identityVerifiedName: null,
    identityVerifiedAt: null,
  }, currentLegalVersion, true, "applicant");
  assert.equal(identityReview.key, "identity");
  assert.equal(identityReview.owner, "system");

  const approval = nextScoutOnboardingStep(readyScout, currentLegalVersion, true, "applicant");
  assert.equal(approval.key, "approval");
  assert.equal(approval.owner, "system");
  assert.equal(nextScoutOnboardingStep(readyScout, currentLegalVersion, true, "approved").key, "complete");
});

test("admin Stripe refresh authorizes before lookup and only synchronizes the stored account", () => {
  const start = stripeActions.indexOf("export async function adminRefreshScoutStripeStatus");
  const end = stripeActions.indexOf("export async function openScoutStripeDashboard", start);
  assert.ok(start >= 0 && end > start);
  const action = stripeActions.slice(start, end);

  const authorization = action.indexOf("await requireAdminUser()");
  const lookup = action.indexOf("getDb().select");
  const sync = action.indexOf("syncStripeAccountById(profile.stripeAccountId)");
  assert.ok(authorization >= 0 && authorization < lookup && lookup < sync);
  assert.match(action, /if \(!profile\) return \{ ok: false, error: "Scout profile not found\." \}/);
  assert.match(action, /if \(!profile\.stripeAccountId\) return \{ ok: false, error: "This Scout has not created a Stripe payout account yet\." \}/);
  assert.match(action, /!synced \|\| synced\.id !== profile\.id/);
  assert.doesNotMatch(action, /getOrCreateScoutStripeAccount|createScoutStripeAccountLink|reconcileCompletedMissionSettlements|processPaymentTransfer/);

  for (const path of [
    "/control-room",
    "/control-room/scouts",
    "/dashboard/scout",
    "/dashboard/scout/earnings",
    "/dashboard/scout/missions",
    "/dashboard/scout/settings",
  ]) {
    assert.match(action, new RegExp(`revalidatePath\\("${path}"\\)`));
  }
});

test("Control Room receives useful Stripe diagnostics without exposing the account identifier", () => {
  assert.match(controlRoomPage, /await requireAdminUser\(\)/);
  assert.match(controlRoomPage, /nextScoutOnboardingStep\(readinessInput/);
  assert.match(controlRoomPage, /scoutStripeReadinessChecklist\(readinessInput/);
  assert.match(controlRoomPage, /hasAccount: Boolean\(profile\.stripeAccountId\)/);
  assert.match(controlRoomPage, /syncedAt: profile\.stripeConnectSyncedAt\?\.toISOString\(\)/);
  assert.match(controlRoomPage, /currentlyDue: profile\.stripeRequirementsCurrentlyDue/);
  assert.match(controlRoomPage, /pastDue: profile\.stripeRequirementsPastDue/);
  assert.match(controlRoomPage, /pendingVerification: profile\.stripeRequirementsPendingVerification/);
  assert.match(controlRoomPage, /futureDue: profile\.stripeRequirementsFutureDue/);
  assert.doesNotMatch(controlRoomPage, /stripeAccountId:\s*profile\.stripeAccountId/);

  assert.match(controlRoomScouts, /adminRefreshScoutStripeStatus\(scout\.id\)/);
  assert.match(controlRoomScouts, /scout\.stripe\.hasAccount && <button/);
  assert.match(controlRoomScouts, /Stripe payout readiness/);
  assert.match(controlRoomScouts, /Scout action required/);
  assert.match(controlRoomScouts, /Stripe is reviewing/);
  assert.match(controlRoomScouts, /Future Stripe requirements/);
  assert.match(controlRoomScouts, /stripe\.checks\.every\(\(check\) => check\.state === "complete"\)/);
  assert.match(controlRoomScouts, /Stripe account: \{stripe\.statusLabel\}/);
  assert.match(controlRoomScouts, /Payout setup ready/);
  assert.match(controlRoomScouts, /\[\.\.\.new Set\(\[\.\.\.stripe\.pastDue, \.\.\.stripe\.currentlyDue\]\)\]/);
  assert.match(controlRoomScouts, /timeZone: "UTC"/);
  assert.doesNotMatch(controlRoomScouts, /stripeAccountId/);
});

test("a transient Stripe schedule lookup cannot erase a previously verified schedule", () => {
  assert.match(stripeConnectService, /let payoutScheduleConfiguredAt: Date \| null = summary\.transfersActive && summary\.payoutsEnabled[\s\S]*existing\.stripePayoutScheduleConfiguredAt/);
  assert.match(stripeConnectService, /let authoritativeNoncomplianceObserved = false/);
  assert.match(stripeConnectService, /if \(!fridaySchedule\) \{[\s\S]*authoritativeNoncomplianceObserved = true;[\s\S]*payoutScheduleConfiguredAt = null/);
  assert.match(stripeConnectService, /if \(!authoritativeNoncomplianceObserved\) \{[\s\S]*payoutScheduleConfiguredAt = existing\.stripePayoutScheduleConfiguredAt/);
});
