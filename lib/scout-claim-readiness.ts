import { eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { scoutProfiles, users } from "@/db/schema";
import { LEGAL_VERSION } from "@/lib/legal";
import { SCOUT_HANDBOOK_VERSION } from "@/lib/scout-handbook";

/** Shared query conditions for selecting Scouts who are allowed to claim. */
export function scoutClaimReadinessConditions(
  expectedLivemode: boolean,
  allowedStatuses: Array<typeof scoutProfiles.$inferSelect.status> = ["approved"],
) {
  return [
    ...scoutUserClaimReadinessConditions(),
    ...scoutProfileClaimReadinessConditions(expectedLivemode, allowedStatuses),
  ];
}

/** User-account half of the canonical claim gate. */
export function scoutUserClaimReadinessConditions() {
  return [
    eq(users.role, "scout"),
    eq(users.status, "active"),
    eq(users.legalVersion, LEGAL_VERSION),
    isNotNull(users.legalAcceptedAt),
    sql`btrim(COALESCE(${users.firstName}, '')) <> ''`,
    sql`btrim(COALESCE(${users.lastName}, '')) <> ''`,
    sql`length(regexp_replace(COALESCE(${users.phone}, ''), '\\D', '', 'g')) >= 10`,
  ];
}

/** Scout-profile half of the canonical claim gate, reusable in atomic updates. */
export function scoutProfileClaimReadinessConditions(
  expectedLivemode: boolean,
  allowedStatuses: Array<typeof scoutProfiles.$inferSelect.status> = ["approved"],
) {
  return [
    inArray(scoutProfiles.status, allowedStatuses),
    eq(scoutProfiles.identityCheck, "clear"),
    inArray(scoutProfiles.identityProvider, ["stripe_connect_v1", "stripe_connect_v2"]),
    isNotNull(scoutProfiles.identityVerificationReference),
    isNull(scoutProfiles.identityVerifiedBy),
    isNotNull(scoutProfiles.identityVerifiedName),
    isNotNull(scoutProfiles.identityVerifiedAt),
    sql`btrim(${scoutProfiles.identityVerifiedName}) <> ''`,
    sql`btrim(${scoutProfiles.identityVerificationReference}) <> ''`,
    isNotNull(scoutProfiles.headshotPath),
    sql`${scoutProfiles.homeZip} ~ '^[0-9]{5}$'`,
    inArray(scoutProfiles.serviceRadiusMiles, [10, 25, 50, 75]),
    sql`btrim(COALESCE(${scoutProfiles.vehicleType}, '')) <> ''`,
    sql`(${scoutProfiles.canSee} OR ${scoutProfiles.canMove} OR ${scoutProfiles.canMeet})`,
    eq(scoutProfiles.handbookVersion, SCOUT_HANDBOOK_VERSION),
    isNotNull(scoutProfiles.handbookAcceptedAt),
    isNotNull(scoutProfiles.verificationConsentedAt),
    isNotNull(scoutProfiles.stripeAccountId),
    isNotNull(scoutProfiles.stripeAccountApiVersion),
    sql`(
      (${scoutProfiles.stripeAccountApiVersion} = 'v1' AND ${scoutProfiles.identityProvider} = 'stripe_connect_v1')
      OR (${scoutProfiles.stripeAccountApiVersion} = 'v2' AND ${scoutProfiles.identityProvider} = 'stripe_connect_v2')
    )`,
    eq(scoutProfiles.stripeAccountLivemode, expectedLivemode),
    eq(scoutProfiles.stripeSyncCompletedGeneration, scoutProfiles.stripeSyncGeneration),
    eq(scoutProfiles.stripeConnectStatus, "ready"),
    eq(scoutProfiles.stripeDetailsSubmitted, true),
    eq(scoutProfiles.stripeTransfersActive, true),
    eq(scoutProfiles.payoutsEnabled, true),
    isNotNull(scoutProfiles.stripeOnboardingCompletedAt),
    isNotNull(scoutProfiles.stripePayoutScheduleConfiguredAt),
    sql`jsonb_array_length(${scoutProfiles.stripeRequirementsCurrentlyDue}) = 0`,
    sql`jsonb_array_length(${scoutProfiles.stripeRequirementsPastDue}) = 0`,
    sql`jsonb_array_length(${scoutProfiles.stripeRequirementsPendingVerification}) = 0`,
  ];
}
