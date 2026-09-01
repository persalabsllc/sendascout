import "server-only";

import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { notifications, scoutProfiles, users } from "@/db/schema";
import { LEGAL_VERSION } from "@/lib/legal";
import { alertScoutToOpenMissions, notifyUserOnce } from "@/lib/notifications";
import { scoutClaimReadinessConditions } from "@/lib/scout-claim-readiness";
import { SCOUT_HANDBOOK_VERSION } from "@/lib/scout-handbook";
import { getStripeLivemode } from "@/lib/stripe";

export type ScoutAutoApprovalResult = {
  approved: boolean;
  userId: string;
  profileId?: string;
};

/**
 * Atomically approves a Scout only when every self-service trust, profile and
 * payout gate is still satisfied in the database. Concurrent calls are safe:
 * only the call that transitions applicant/review to approved receives a row.
 */
export async function tryAutoApproveScout(userId: string): Promise<ScoutAutoApprovalResult> {
  const now = new Date();
  const stripeLivemode = getStripeLivemode();
  const [approved] = await getDb().update(scoutProfiles).set({
    status: "approved",
    approvedAt: now,
    updatedAt: now,
  }).where(and(
    eq(scoutProfiles.userId, userId),
    inArray(scoutProfiles.status, ["applicant", "review"]),
    eq(scoutProfiles.identityCheck, "clear"),
    inArray(scoutProfiles.identityProvider, ["stripe_connect_v1", "stripe_connect_v2"]),
    isNotNull(scoutProfiles.identityVerificationReference),
    isNotNull(scoutProfiles.identityVerifiedName),
    isNotNull(scoutProfiles.identityVerifiedAt),
    isNull(scoutProfiles.identityVerifiedBy),
    sql`btrim(${scoutProfiles.identityVerifiedName}) <> ''`,
    sql`btrim(${scoutProfiles.identityVerificationReference}) <> ''`,
    isNotNull(scoutProfiles.headshotPath),
    eq(scoutProfiles.handbookVersion, SCOUT_HANDBOOK_VERSION),
    isNotNull(scoutProfiles.handbookAcceptedAt),
    sql`${scoutProfiles.homeZip} ~ '^[0-9]{5}$'`,
    inArray(scoutProfiles.serviceRadiusMiles, [10, 25, 50, 75]),
    sql`btrim(COALESCE(${scoutProfiles.vehicleType}, '')) <> ''`,
    sql`(${scoutProfiles.canSee} OR ${scoutProfiles.canMove} OR ${scoutProfiles.canMeet})`,
    isNotNull(scoutProfiles.verificationConsentedAt),
    isNotNull(scoutProfiles.stripeAccountId),
    isNotNull(scoutProfiles.stripeAccountApiVersion),
    sql`(
      (${scoutProfiles.stripeAccountApiVersion} = 'v1' AND ${scoutProfiles.identityProvider} = 'stripe_connect_v1')
      OR (${scoutProfiles.stripeAccountApiVersion} = 'v2' AND ${scoutProfiles.identityProvider} = 'stripe_connect_v2')
    )`,
    eq(scoutProfiles.stripeAccountLivemode, stripeLivemode),
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
    sql`EXISTS (
      SELECT 1
      FROM ${users} AS approval_user
      WHERE approval_user.id = ${scoutProfiles.userId}
        AND approval_user.role = 'scout'
        AND approval_user.status = 'active'
        AND approval_user.legal_version = ${LEGAL_VERSION}
        AND approval_user.legal_accepted_at IS NOT NULL
        AND btrim(COALESCE(approval_user.first_name, '')) <> ''
        AND btrim(COALESCE(approval_user.last_name, '')) <> ''
        AND length(regexp_replace(COALESCE(approval_user.phone, ''), '\\D', '', 'g')) >= 10
    )`,
  )).returning({
    profileId: scoutProfiles.id,
    userId: scoutProfiles.userId,
  });

  if (!approved) return { approved: false, userId };

  let missionAlertsBackfilled = false;
  try {
    await alertScoutToOpenMissions(approved.userId);
    missionAlertsBackfilled = true;
  } catch (error) {
    console.warn("Scout auto-approved, but existing mission alerts could not be backfilled", {
      profileId: approved.profileId,
      userId: approved.userId,
      error,
    });
  }

  // The durable approval notice doubles as the recovery checkpoint. Never
  // record it after an alert-backfill exception, or the hourly worker would no
  // longer know that this newly approved Scout still needs side effects.
  if (missionAlertsBackfilled) {
    try {
      await ensureScoutApprovalNotification(approved.userId);
    } catch (error) {
      console.error("Scout auto-approved, but the approval notification could not be queued", {
        profileId: approved.profileId,
        userId: approved.userId,
        error,
      });
    }
  }

  revalidateScoutApprovalPaths();
  return { approved: true, userId: approved.userId, profileId: approved.profileId };
}

/**
 * Recovers applicants whose final onboarding write or Stripe webhook completed
 * without running the normal post-write auto-approval hook.
 */
export async function reconcileScoutAutoApprovals(limit = 100) {
  const boundedLimit = Math.max(1, Math.min(250, limit));
  const stripeLivemode = getStripeLivemode();
  const candidates = await getDb().select({ userId: scoutProfiles.userId })
    .from(scoutProfiles)
    .innerJoin(users, eq(users.id, scoutProfiles.userId))
    .where(and(...scoutClaimReadinessConditions(stripeLivemode, ["applicant", "review"])))
    .limit(boundedLimit);
  let approved = 0;
  let errors = 0;
  for (const candidate of candidates) {
    try {
      if ((await tryAutoApproveScout(candidate.userId)).approved) approved += 1;
    } catch (error) {
      errors += 1;
      console.error("Scout auto-approval reconciliation failed", { userId: candidate.userId, error });
    }
  }

  // A process can stop after the atomic status update or during a provider
  // request. Select only fully ready Scouts with a missing checkpoint or a
  // recoverable one-time delivery; database dedupe keys make the replay safe.
  const missingNotices = await getDb().select({ userId: scoutProfiles.userId })
    .from(scoutProfiles)
    .innerJoin(users, eq(users.id, scoutProfiles.userId))
    .where(and(
      ...scoutClaimReadinessConditions(stripeLivemode),
      sql`(
        NOT EXISTS (
          SELECT 1
          FROM ${notifications} AS approval_notice
          WHERE approval_notice.recipient_user_id = ${scoutProfiles.userId}
            AND approval_notice.mission_id IS NULL
            AND approval_notice.channel = 'in_app'
            AND approval_notice.kind = 'scout_approved'
        )
        OR EXISTS (
          SELECT 1
          FROM ${notifications} AS recoverable_delivery
          WHERE recoverable_delivery.recipient_user_id = ${scoutProfiles.userId}
            AND recoverable_delivery.kind IN ('scout_approved', 'new_mission')
            AND recoverable_delivery.channel IN ('email', 'sms')
            AND recoverable_delivery.status = 'pending'
            AND recoverable_delivery.provider_message_id IS NULL
            AND (
              (recoverable_delivery.channel = 'email' AND ${users.emailNotificationsEnabled} = TRUE)
              OR (
                recoverable_delivery.channel = 'sms'
                AND ${users.smsNotificationsEnabled} = TRUE
                AND ${users.smsConsentedAt} IS NOT NULL
              )
            )
        )
      )`,
    ))
    .limit(boundedLimit);
  let notificationsRecovered = 0;
  for (const candidate of missingNotices) {
    try {
      // Backfill alerts before recording the durable approval notice. If the
      // process stops here, the same missing-notice row remains recoverable.
      await alertScoutToOpenMissions(candidate.userId);
      const notice = await ensureScoutApprovalNotification(candidate.userId);
      if (notice.created || notice.emailQueued) notificationsRecovered += 1;
    } catch (error) {
      errors += 1;
      console.error("Scout approval notification recovery failed", { userId: candidate.userId, error });
    }
  }
  return {
    found: candidates.length,
    approved,
    missingNotices: missingNotices.length,
    notificationsRecovered,
    errors,
  };
}

export async function ensureScoutApprovalNotification(userId: string) {
  return notifyUserOnce({
    recipientUserId: userId,
    kind: "scout_approved",
    title: "You’re ready to claim missions",
    body: "Your identity and payout account are verified, and your Scout onboarding is complete.",
    actionLabel: "Browse missions",
    actionUrl: "https://sendascout.com/dashboard/scout/missions",
  }, {
    stillEligible: async () => {
      const [ready] = await getDb().select({ userId: scoutProfiles.userId })
        .from(scoutProfiles)
        .innerJoin(users, eq(users.id, scoutProfiles.userId))
        .where(and(
          eq(scoutProfiles.userId, userId),
          ...scoutClaimReadinessConditions(getStripeLivemode()),
        ))
        .limit(1);
      return Boolean(ready);
    },
  });
}

function revalidateScoutApprovalPaths() {
  revalidatePath("/dashboard/scout");
  revalidatePath("/dashboard/scout/missions");
  revalidatePath("/dashboard/scout/settings");
  revalidatePath("/dashboard/scout/earnings");
  revalidatePath("/control-room");
  revalidatePath("/control-room/scouts");
}
