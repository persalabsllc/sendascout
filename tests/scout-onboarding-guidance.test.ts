import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildScoutOnboardingProgress,
  type ScoutOnboardingProgressInput,
} from "../lib/scout-onboarding-progress.ts";
import {
  scoutOnboardingReminderBody,
  scoutOnboardingReminderStage,
} from "../lib/scout-onboarding-reminder-policy.ts";

const reminderWorker = readFileSync(new URL("../lib/scout-onboarding-reminders.ts", import.meta.url), "utf8");
const onboardingStatus = readFileSync(new URL("../lib/scout-onboarding-status.ts", import.meta.url), "utf8");
const notifications = readFileSync(new URL("../lib/notifications.ts", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../components/dashboard.tsx", import.meta.url), "utf8");
const tracker = readFileSync(new URL("../components/scout-onboarding-progress.tsx", import.meta.url), "utf8");
const onboarding = readFileSync(new URL("../components/onboarding-form.tsx", import.meta.url), "utf8");
const onboardingAction = readFileSync(new URL("../app/actions/onboarding.ts", import.meta.url), "utf8");
const profileActions = readFileSync(new URL("../app/actions/profile.ts", import.meta.url), "utf8");
const scoutSettings = readFileSync(new URL("../components/scout-settings-form.tsx", import.meta.url), "utf8");
const cron = readFileSync(new URL("../app/api/cron/auto-complete/route.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../db/schema.ts", import.meta.url), "utf8");
const notificationDedupeMigration = readFileSync(new URL("../db/migrations/0018_notification_dedupe.sql", import.meta.url), "utf8");

const completeInput: ScoutOnboardingProgressInput = {
  firstName: "Tessa",
  lastName: "Scout",
  phone: "252-555-0100",
  legalVersion: "2026-08-29-v1",
  legalAcceptedAt: new Date("2026-09-01T00:00:00Z"),
  handbookVersion: "2026-09-01-v1",
  handbookAcceptedAt: new Date("2026-09-01T00:05:00Z"),
  headshotPath: "scout-headshots/example.jpg",
  homeZip: "28560",
  serviceRadiusMiles: 25,
  vehicleType: "Pickup truck",
  canSee: true,
  canMove: true,
  canMeet: true,
  verificationConsentedAt: new Date("2026-09-01T00:05:00Z"),
  identityCheck: "clear",
  identityProvider: "stripe_connect_v2",
  identityVerificationReference: "acct_example",
  identityVerifiedName: "Tessa Scout",
  identityVerifiedAt: new Date("2026-09-01T00:10:00Z"),
  identityVerifiedBy: null,
  stripeAccountId: "acct_example",
  stripeAccountApiVersion: "v2",
  stripeAccountLivemode: true,
  stripeConnectStatus: "ready",
  stripeDetailsSubmitted: true,
  stripeTransfersActive: true,
  payoutsEnabled: true,
  stripeRequirementsCurrentlyDue: [],
  stripeRequirementsPastDue: [],
  stripeRequirementsPendingVerification: [],
  stripeOnboardingCompletedAt: new Date("2026-09-01T00:10:00Z"),
  stripePayoutScheduleConfiguredAt: new Date("2026-09-01T00:10:00Z"),
  stripeSyncGeneration: 0,
  stripeSyncCompletedGeneration: 0,
};

test("Scout progress tracker identifies completed work and links directly to the next missing step", () => {
  const progress = buildScoutOnboardingProgress({
    ...completeInput,
    handbookVersion: null,
    handbookAcceptedAt: null,
    identityCheck: "pending",
    identityProvider: "stripe_connect_v2",
    identityVerifiedName: null,
    identityVerifiedAt: null,
    stripeConnectStatus: "onboarding",
    stripeTransfersActive: false,
    payoutsEnabled: false,
    stripeOnboardingCompletedAt: null,
    stripePayoutScheduleConfiguredAt: null,
  }, true);

  assert.equal(progress.ready, false);
  assert.equal(progress.completedCount, 4);
  assert.equal(progress.totalCount, 7);
  assert.equal(progress.nextStep?.key, "handbook");
  assert.equal(progress.nextStep?.href, "/dashboard/scout/handbook");
  assert.deepEqual(progress.steps.filter((step) => !step.complete).map((step) => step.key), ["handbook", "identity", "payouts"]);
});

test("only Stripe-authoritative identity and payout readiness complete Scout onboarding", () => {
  assert.equal(buildScoutOnboardingProgress(completeInput, true).ready, true);
  assert.equal(buildScoutOnboardingProgress({ ...completeInput, identityProvider: "manual_admin_review" }, true).ready, false);
  assert.equal(buildScoutOnboardingProgress({ ...completeInput, identityVerificationReference: null }, true).ready, false);
  assert.equal(buildScoutOnboardingProgress({ ...completeInput, stripeAccountApiVersion: "v1" }, true).ready, false);
  assert.equal(buildScoutOnboardingProgress({ ...completeInput, stripeAccountLivemode: false }, true).ready, false);
  assert.equal(buildScoutOnboardingProgress({ ...completeInput, stripeDetailsSubmitted: false }, true).ready, false);
  assert.equal(buildScoutOnboardingProgress({ ...completeInput, stripeRequirementsPendingVerification: ["identity"] }, true).ready, false);
  assert.equal(buildScoutOnboardingProgress({ ...completeInput, stripeOnboardingCompletedAt: null }, true).ready, false);
  assert.equal(buildScoutOnboardingProgress({ ...completeInput, stripeSyncGeneration: 1 }, true).ready, false);
});

test("reminders use five deterministic milestones instead of a daily cadence", () => {
  const createdAt = new Date("2026-09-01T00:00:00Z");
  assert.equal(scoutOnboardingReminderStage(createdAt, new Date("2026-09-01T05:59:00Z")), null);
  assert.equal(scoutOnboardingReminderStage(createdAt, new Date("2026-09-01T06:00:00Z"))?.key, "six_hours");
  assert.equal(scoutOnboardingReminderStage(createdAt, new Date("2026-09-04T00:00:00Z"))?.key, "two_days");
  assert.equal(scoutOnboardingReminderStage(createdAt, new Date("2026-09-09T00:00:00Z"))?.key, "seven_days");
  assert.equal(scoutOnboardingReminderStage(createdAt, new Date("2026-10-10T00:00:00Z"))?.key, "twenty_eight_days");
});

test("reminder copy is a general progress tracker without Stripe account details", () => {
  const progress = buildScoutOnboardingProgress({
    ...completeInput,
    identityCheck: "pending",
    identityVerifiedName: null,
    identityVerifiedAt: null,
    stripeConnectStatus: "pending",
    stripeTransfersActive: false,
    payoutsEnabled: false,
    stripeOnboardingCompletedAt: null,
    stripePayoutScheduleConfiguredAt: null,
  }, true);
  const body = scoutOnboardingReminderBody(progress);
  assert.match(body, /COMPLETED/);
  assert.match(body, /STILL NEEDED/);
  assert.match(body, /browse any matching missions/);
  assert.doesNotMatch(body, /acct_example|requirements_currently_due/i);
});

test("hourly reminders stop for non-active lifecycle states and deduplicate each milestone atomically", () => {
  assert.match(onboardingStatus, /eq\(users\.status, "active"\)/);
  assert.match(onboardingStatus, /inArray\(scoutProfiles\.status, \["applicant", "review"\]\)/);
  assert.match(reminderWorker, /await tryAutoApproveScout\(candidate\.userId\)/);
  assert.match(reminderWorker, /progress\.ready \|\| !progress\.nextStep/);
  assert.match(reminderWorker, /notifyUserOnce/);
  assert.match(reminderWorker, /NOT EXISTS/);
  assert.match(reminderWorker, /latestEligibleReminderKind/);
  assert.match(reminderWorker, /stillEligible: \(\) => scoutStillNeedsOnboardingReminder/);
  assert.match(schema, /dedupeKey: text\("dedupe_key"\)/);
  assert.match(schema, /uniqueIndex\("notifications_dedupe_key_idx"\)\.on\(table\.dedupeKey\)/);
  assert.match(notificationDedupeMigration, /CREATE UNIQUE INDEX "notifications_dedupe_key_idx"/);
  assert.match(notifications, /onConflictDoNothing\(\{ target: notifications\.dedupeKey \}\)/);
  assert.match(notifications, /Idempotency-Key/);
  assert.match(notifications, /lastAttemptAt[\s\S]*leaseCutoff/);
  assert.match(notifications, /initialAttemptCount/);
  assert.match(notifications, /recipient\.emailNotificationsEnabled/);
  assert.match(notifications, /options\.stillEligible/);
  assert.match(notifications, /isScoutOnboardingNotificationKind\(item\.kind\)/);
  assert.match(notifications, /currentEmailRetryPayload\(item\)/);
  assert.match(notifications, /scoutOnboardingReminderBody\(progress\)/);
  assert.match(notifications, /sameEmailPayload\(storedPayload, currentPayload\)/);
  assert.match(notifications, /item\.kind === "scout_approved"/);
  assert.match(notifications, /scoutClaimReadinessConditions\(getStripeLivemode\(\)\)/);
  assert.match(notifications, /currentRecipient\.emailNotificationsEnabled/);
  assert.match(reminderWorker, /WELCOME_REMINDER_COOLDOWN_MS/);
  assert.match(reminderWorker, /prior_welcome\.created_at <= \$\{welcomeCooldownCutoff\}/);
  assert.match(reminderWorker, /COALESCE\(recent_welcome_email\.last_attempt_at, recent_welcome_email\.created_at\) > \$\{welcomeCooldownCutoff\}/);
  assert.doesNotMatch(notifications, /pg_advisory_xact_lock/);
});

test("dashboard and email guide Scouts to the exact next step and support", () => {
  assert.match(dashboard, /ScoutOnboardingProgressTracker/);
  assert.match(tracker, /progress\.nextStep\.href/);
  assert.match(tracker, /mailto:\$\{SCOUT_SUPPORT_EMAIL\}/);
  assert.match(notifications, /mailto:support@sendascout\.com/);
  assert.match(onboarding, /Finish Stripe payout setup/);
  assert.doesNotMatch(onboardingAction, /sendScoutOnboardingWelcome/);
  assert.match(profileActions, /after\(async \(\) => \{[\s\S]*await sendScoutOnboardingWelcome\(user\.id\)/);
  assert.match(reminderWorker, /kind: "scout_onboarding_welcome"/);
  assert.match(scoutSettings, /Legal first name/);
  assert.match(scoutSettings, /Mobile number/);
  assert.match(scoutSettings, /Identity and payout verification/);
  assert.match(scoutSettings, /id="scout-contact"/);
  assert.match(scoutSettings, /id="scout-headshot"/);
  assert.match(scoutSettings, /id="scout-service"/);
  assert.match(scoutSettings, /Email account &amp; mission alerts/);
  assert.doesNotMatch(onboarding, /identity and background verification/);
  assert.doesNotMatch(onboarding, /Control Room can approve your application/);
});

test("hourly operations reconcile Stripe and auto-approval before onboarding reminders", () => {
  const hourlyRoute = cron.slice(cron.indexOf("export async function GET"));
  const payoutIndex = hourlyRoute.indexOf("reconcileScoutPayoutReadiness()");
  const approvalIndex = hourlyRoute.indexOf("reconcileScoutAutoApprovals()");
  const reminderIndex = hourlyRoute.indexOf("runScoutOnboardingReminders()");
  assert.ok(payoutIndex >= 0 && payoutIndex < approvalIndex);
  assert.ok(approvalIndex < reminderIndex);
});
