import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { scoutProfiles, users } from "@/db/schema";
import { buildScoutOnboardingProgress } from "@/lib/scout-onboarding-progress";
import { getStripeLivemode } from "@/lib/stripe";

export type ActiveScoutOnboardingRow = {
  user: typeof users.$inferSelect;
  profile: typeof scoutProfiles.$inferSelect;
};

export async function loadActiveScoutOnboarding(userId: string): Promise<ActiveScoutOnboardingRow | null> {
  const [current] = await getDb().select({
    user: users,
    profile: scoutProfiles,
  }).from(scoutProfiles).innerJoin(users, eq(users.id, scoutProfiles.userId)).where(and(
    eq(users.id, userId),
    eq(users.role, "scout"),
    eq(users.status, "active"),
    inArray(scoutProfiles.status, ["applicant", "review"]),
  )).limit(1);
  return current ?? null;
}

export function onboardingProgressFor(current: ActiveScoutOnboardingRow) {
  return buildScoutOnboardingProgress({
    firstName: current.user.firstName,
    lastName: current.user.lastName,
    phone: current.user.phone,
    legalVersion: current.user.legalVersion,
    legalAcceptedAt: current.user.legalAcceptedAt,
    handbookVersion: current.profile.handbookVersion,
    handbookAcceptedAt: current.profile.handbookAcceptedAt,
    headshotPath: current.profile.headshotPath,
    homeZip: current.profile.homeZip,
    serviceRadiusMiles: current.profile.serviceRadiusMiles,
    vehicleType: current.profile.vehicleType,
    canSee: current.profile.canSee,
    canMove: current.profile.canMove,
    canMeet: current.profile.canMeet,
    verificationConsentedAt: current.profile.verificationConsentedAt,
    identityCheck: current.profile.identityCheck,
    identityProvider: current.profile.identityProvider,
    identityVerificationReference: current.profile.identityVerificationReference,
    identityVerifiedName: current.profile.identityVerifiedName,
    identityVerifiedAt: current.profile.identityVerifiedAt,
    identityVerifiedBy: current.profile.identityVerifiedBy,
    stripeAccountId: current.profile.stripeAccountId,
    stripeAccountApiVersion: current.profile.stripeAccountApiVersion,
    stripeAccountLivemode: current.profile.stripeAccountLivemode,
    stripeConnectStatus: current.profile.stripeConnectStatus,
    stripeDetailsSubmitted: current.profile.stripeDetailsSubmitted,
    stripeTransfersActive: current.profile.stripeTransfersActive,
    payoutsEnabled: current.profile.payoutsEnabled,
    stripeRequirementsCurrentlyDue: current.profile.stripeRequirementsCurrentlyDue,
    stripeRequirementsPastDue: current.profile.stripeRequirementsPastDue,
    stripeRequirementsPendingVerification: current.profile.stripeRequirementsPendingVerification,
    stripeOnboardingCompletedAt: current.profile.stripeOnboardingCompletedAt,
    stripePayoutScheduleConfiguredAt: current.profile.stripePayoutScheduleConfiguredAt,
    stripeSyncGeneration: current.profile.stripeSyncGeneration,
    stripeSyncCompletedGeneration: current.profile.stripeSyncCompletedGeneration,
  }, getStripeLivemode());
}

export function scoutOnboardingProgressFingerprint(progress: ReturnType<typeof onboardingProgressFor>) {
  return progress.steps.map((step) => `${step.key}:${step.complete ? "complete" : "missing"}`).join("|");
}

/** Returns true only while this active applicant still has incomplete setup. */
export async function scoutStillNeedsOnboardingReminder(userId: string, expectedFingerprint?: string) {
  const current = await loadActiveScoutOnboarding(userId);
  if (!current) return false;
  const progress = onboardingProgressFor(current);
  return !progress.ready
    && (!expectedFingerprint || scoutOnboardingProgressFingerprint(progress) === expectedFingerprint);
}
