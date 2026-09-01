"use server";

import { get, head } from "@vercel/blob";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { revalidatePath } from "next/cache";
import sharp from "sharp";
import { getDb } from "@/db";
import {
  missionBundles,
  missionCases,
  missionChangeOrders,
  missionChecklistItems,
  missionEvidence,
  missionMessages,
  missionPartResults,
  missionReviews,
  missions,
  missionUpdates,
  notifications,
  payments,
  customerPreferredScouts,
  scoutProfiles,
  users,
} from "@/db/schema";
import { requireAdminUser, requireAppUser } from "@/lib/app-user";
import { reportException } from "@/lib/observability";
import {
  alertEligibleScouts,
  alertScoutToOpenMissions,
  missionClaimedNotificationInput,
  notificationChannelDedupeKey,
  notifyUser,
  notifyUserOnce,
} from "@/lib/notifications";
import { isMissionEligibleForScout } from "@/lib/scout-matching";
import { calculateMissionQuote, meetPriceForMinutes } from "@/lib/mission-pricing";
import { ENHANCED_REPORT_CUSTOMER_CENTS, ENHANCED_REPORT_SCOUT_CENTS } from "@/lib/mission-pricing-core";
import { geographicDistanceMeters, verifyScoutAtLocation } from "@/lib/mission-verification";
import { formatDateTime } from "@/lib/time";
import { scoutApprovalChecklist, scoutReadyForApproval } from "@/lib/scout-approval";
import { ensureScoutApprovalNotification } from "@/lib/scout-auto-approval";
import { scoutProfileClaimReadinessConditions } from "@/lib/scout-claim-readiness";
import { LEGAL_VERSION } from "@/lib/legal";
import { SCOUT_HANDBOOK_VERSION, hasCurrentScoutHandbookAcceptance } from "@/lib/scout-handbook";
import { getStripeLivemode } from "@/lib/stripe";
import { cancelUncollectedBookingCheckout } from "@/lib/stripe-payments";
import { settleMissionBestEffort } from "@/lib/stripe-settlement";
import { attemptSavedPayment, ensureAddonPayment } from "@/lib/stripe-payment-addons";
import { meetActionIsAvailable, meetActionOpensAt } from "@/lib/mission-timing";
import {
  isDeliveryPinLocked,
  nextDeliveryPinFailureState,
  verifyDeliveryPin as deliveryPinMatches,
} from "@/lib/delivery-pin";
import { isVerifiedDeliveryPhoto } from "@/lib/mission-evidence";

type MissionStatus = typeof missions.$inferSelect.status;
type Result = { ok: true } | { ok: false; error: string };
export type MissionChecklistResponseInput = {
  itemId: string;
  responseText?: string;
  mediaUrls?: string[];
};

const allowedResultContentTypes = new Set([
  "image/jpeg", "image/png", "image/webp",
  "video/mp4", "video/quicktime", "video/webm",
]);
const maxResultFileSize = 50 * 1024 * 1024;
const maxResultFileCount = 24;
const maxResultTotalSize = 250 * 1024 * 1024;
const changeOrderCustomerCents = 900;
const changeOrderScoutCents = 600;
const enhancedReportCustomerCents = ENHANCED_REPORT_CUSTOMER_CENTS;
const enhancedReportScoutCents = ENHANCED_REPORT_SCOUT_CENTS;

function databaseErrorCode(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

const activeStatuses: MissionStatus[] = [
  "claimed", "en_route", "onsite", "en_route_pickup", "at_pickup", "en_route_dropoff", "at_dropoff", "submitted",
];

function refreshMission(id: string) {
  revalidatePath(`/dashboard/missions/${id}`);
  revalidatePath("/dashboard/customer");
  revalidatePath("/dashboard/customer/payments");
  revalidatePath("/dashboard/scout");
  revalidatePath("/control-room");
}

async function getMission(id: string) {
  const [mission] = await getDb().select().from(missions).where(eq(missions.id, id)).limit(1);
  if (!mission) throw new Error("Mission not found.");
  if (mission.archivedAt) throw new Error("This mission has been archived and can no longer be changed.");
  return mission;
}

async function getBundleContext(mission: typeof missions.$inferSelect) {
  if (!mission.bundleId) return null;
  const db = getDb();
  const [[bundle], legs] = await Promise.all([
    db.select().from(missionBundles).where(eq(missionBundles.id, mission.bundleId)).limit(1),
    db.select().from(missions).where(and(eq(missions.bundleId, mission.bundleId), isNull(missions.archivedAt))).orderBy(asc(missions.bundleSequence)),
  ]);
  if (!bundle || !mission.bundleSequence || !legs.length) throw new Error("This mission bundle is incomplete. Contact support before continuing.");
  return { bundle, legs };
}

async function requireActiveBundleLeg(mission: typeof missions.$inferSelect) {
  const context = await getBundleContext(mission);
  if (context && mission.bundleSequence !== context.bundle.activeSequence) {
    throw new Error(`Part ${context.bundle.activeSequence} must be completed before this mission part can be changed.`);
  }
  return context;
}

function uniqueMissionPaths(id: string, values: string[]) {
  const prefix = `mission-results/${id}/`;
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.startsWith(prefix) && !value.includes("..")))].slice(0, 24);
}

async function verifiedBlobMetadata(pathnames: string[]) {
  return Promise.all(pathnames.map(async (pathname) => {
    const metadata = await head(pathname);
    if (metadata.pathname !== pathname || !allowedResultContentTypes.has(metadata.contentType) || metadata.size <= 0 || metadata.size > maxResultFileSize) {
      throw new Error("One of the uploaded result files is missing or has an unsupported format.");
    }
    return { pathname, contentType: metadata.contentType, byteSize: metadata.size };
  }));
}

async function verifyDeliveryPhotoContent(pathname: string, contentType: string) {
  const result = await get(pathname, { access: "private" });
  if (!result || result.statusCode !== 200) throw new Error("The delivery photo could not be read from secure storage.");
  const bytes = Buffer.from(await new Response(result.stream).arrayBuffer());
  if (bytes.length <= 0 || bytes.length > 10 * 1024 * 1024) throw new Error("Proof of delivery photos must be 10 MB or smaller.");
  const expectedFormat = new Map([
    ["image/jpeg", "jpeg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
  ]).get(contentType.split(";", 1)[0]!.trim().toLowerCase());
  try {
    const image = sharp(bytes, { failOn: "warning", limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || metadata.width < 64 || metadata.height < 64 || metadata.format !== expectedFormat || (metadata.pages ?? 1) !== 1) {
      throw new Error("invalid image dimensions or format");
    }
    await image.rotate().resize({ width: 32, height: 32, fit: "inside" }).toBuffer();
  } catch {
    throw new Error("Proof of delivery must be a complete, readable JPG, PNG, or WEBP photo at least 64 by 64 pixels.");
  }
}

async function acceptedChangeOrderTotals(missionId: string) {
  const [totals] = await getDb().select({
    customerCents: sql<number>`COALESCE(SUM(${missionChangeOrders.customerDeltaCents}), 0)::integer`,
    scoutCents: sql<number>`COALESCE(SUM(${missionChangeOrders.scoutDeltaCents}), 0)::integer`,
    platformCents: sql<number>`COALESCE(SUM(${missionChangeOrders.platformDeltaCents}), 0)::integer`,
  }).from(missionChangeOrders).where(and(
    eq(missionChangeOrders.missionId, missionId),
    inArray(missionChangeOrders.status, ["approved", "fulfilled"]),
  ));
  return {
    customerCents: Number(totals?.customerCents ?? 0),
    scoutCents: Number(totals?.scoutCents ?? 0),
    platformCents: Number(totals?.platformCents ?? 0),
  };
}

export async function claimMission(id: string): Promise<Result> {
  try {
    const user = await requireAppUser("scout");
    if (user.role !== "scout" || user.status !== "active") throw new Error("Only an active Scout account can claim missions.");
    const db = getDb();
    const [profile] = await db.select().from(scoutProfiles).where(eq(scoutProfiles.userId, user.id)).limit(1);
    if (!profile || profile.status !== "approved") {
      throw new Error("Your Scout account and verified identity must be approved before claiming missions.");
    }
    if (!hasCurrentScoutHandbookAcceptance(profile)) {
      throw new Error("Review and acknowledge the current Scout Handbook before claiming missions.");
    }
    if (!profile.verificationConsentedAt) throw new Error("Complete the Scout verification consent before claiming missions.");
    const stripeLivemode = getStripeLivemode();
    if (!scoutReadyForApproval({
      ...profile,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      legalVersion: user.legalVersion,
      legalAcceptedAt: user.legalAcceptedAt,
    }, LEGAL_VERSION, stripeLivemode)) {
      throw new Error("Finish every Scout onboarding and Stripe payout requirement before claiming missions.");
    }
    const mission = await getMission(id);
    if (mission.customerId === user.id) throw new Error("You cannot claim a mission created by your own account.");
    const bundleContext = await getBundleContext(mission);
    const missionsToCheck = bundleContext?.legs ?? [mission];
    if (mission.paymentStatus !== "paid" || bundleContext?.bundle.paymentStatus && bundleContext.bundle.paymentStatus !== "paid" || missionsToCheck.some((candidate) => candidate.paymentStatus !== "paid")) {
      throw new Error("This mission is not available until its customer payment is confirmed.");
    }
    if (missionsToCheck.some((candidate) => !isMissionEligibleForScout(candidate, profile))) {
      throw new Error("One or more mission stops are outside your selected service area, vehicle capacity, or mission preferences.");
    }

    const now = new Date();
    const firstLookActive = missionsToCheck.some((candidate) => Boolean(
      candidate.preferredScoutId
      && candidate.preferredScoutId !== user.id
      && !candidate.preferredScoutBroadcastAt
      && (!candidate.preferredScoutExclusiveUntil || candidate.preferredScoutExclusiveUntil.getTime() > now.getTime()),
    ));
    if (firstLookActive) throw new Error("This mission is currently in another Scout’s private first-look window.");
    const claimNotification = missionClaimedNotificationInput({
      customerUserId: mission.customerId,
      missionId: id,
      bundleLegCount: bundleContext?.legs.length,
    });
    const claimNotificationDedupeKey = notificationChannelDedupeKey(claimNotification, "in_app");
    if (bundleContext) {
      if (mission.bundleSequence !== bundleContext.bundle.activeSequence || mission.status !== "open") {
        throw new Error("Only the active first part of this mission bundle can be claimed.");
      }
      let claimedBundle: { id: string } | undefined;
      try {
        const claimedBundleResult = await db.execute<{ id: string }>(sql`
        WITH locked_user AS MATERIALIZED (
          SELECT claim_user.id
          FROM users AS claim_user
          WHERE claim_user.id = ${user.id}
            AND claim_user.role = 'scout'
            AND claim_user.status = 'active'
            AND claim_user.legal_version = ${LEGAL_VERSION}
            AND claim_user.legal_accepted_at IS NOT NULL
            AND btrim(COALESCE(claim_user.first_name, '')) <> ''
            AND btrim(COALESCE(claim_user.last_name, '')) <> ''
            AND length(regexp_replace(COALESCE(claim_user.phone, ''), '\\D', '', 'g')) >= 10
          FOR UPDATE
        ), locked_profile AS MATERIALIZED (
          UPDATE scout_profiles AS approved_profile
          SET updated_at = approved_profile.updated_at
          WHERE approved_profile.user_id = ${user.id}
            AND approved_profile.status = 'approved'
            AND approved_profile.identity_check = 'clear'
            AND approved_profile.identity_provider IN ('stripe_connect_v1', 'stripe_connect_v2')
            AND approved_profile.identity_verification_reference IS NOT NULL
            AND btrim(approved_profile.identity_verification_reference) <> ''
            AND approved_profile.identity_verified_by IS NULL
            AND approved_profile.identity_verified_name IS NOT NULL
            AND btrim(approved_profile.identity_verified_name) <> ''
            AND approved_profile.identity_verified_at IS NOT NULL
            AND approved_profile.verification_consented_at IS NOT NULL
            AND approved_profile.headshot_path IS NOT NULL
            AND approved_profile.home_zip ~ '^[0-9]{5}$'
            AND approved_profile.service_radius_miles IN (10, 25, 50, 75)
            AND btrim(COALESCE(approved_profile.vehicle_type, '')) <> ''
            AND (approved_profile.can_see OR approved_profile.can_move OR approved_profile.can_meet)
            AND approved_profile.handbook_version = ${SCOUT_HANDBOOK_VERSION}
            AND approved_profile.handbook_accepted_at IS NOT NULL
            AND approved_profile.home_zip IS NOT DISTINCT FROM ${profile.homeZip}
            AND approved_profile.service_radius_miles = ${profile.serviceRadiusMiles}
            AND approved_profile.vehicle_type IS NOT DISTINCT FROM ${profile.vehicleType}
            AND approved_profile.can_see = ${profile.canSee}
            AND approved_profile.can_move = ${profile.canMove}
            AND approved_profile.can_meet = ${profile.canMeet}
            AND approved_profile.stripe_account_id IS NOT NULL
            AND approved_profile.stripe_account_api_version IS NOT NULL
            AND (
              (approved_profile.stripe_account_api_version = 'v1' AND approved_profile.identity_provider = 'stripe_connect_v1')
              OR (approved_profile.stripe_account_api_version = 'v2' AND approved_profile.identity_provider = 'stripe_connect_v2')
            )
            AND approved_profile.stripe_account_livemode = ${stripeLivemode}
            AND approved_profile.stripe_sync_completed_generation = approved_profile.stripe_sync_generation
            AND approved_profile.stripe_connect_status = 'ready'
            AND approved_profile.stripe_details_submitted = TRUE
            AND approved_profile.stripe_transfers_active = TRUE
            AND approved_profile.payouts_enabled = TRUE
            AND approved_profile.stripe_onboarding_completed_at IS NOT NULL
            AND approved_profile.stripe_payout_schedule_configured_at IS NOT NULL
            AND jsonb_array_length(approved_profile.stripe_requirements_currently_due) = 0
            AND jsonb_array_length(approved_profile.stripe_requirements_past_due) = 0
            AND jsonb_array_length(approved_profile.stripe_requirements_pending_verification) = 0
            AND EXISTS (SELECT 1 FROM locked_user WHERE locked_user.id = approved_profile.user_id)
          RETURNING approved_profile.identity_verified_name, approved_profile.headshot_path, approved_profile.identity_verified_at
        ), target_bundle AS (
          SELECT id, active_sequence
          FROM mission_bundles
          WHERE id = ${mission.bundleId}
            AND status = 'open'
            AND payment_status = 'paid'
            AND active_sequence = ${mission.bundleSequence}
            AND EXISTS (SELECT 1 FROM locked_profile)
            AND NOT EXISTS (
              SELECT 1 FROM missions AS locked_part
              WHERE locked_part.bundle_id = mission_bundles.id
                AND locked_part.archived_at IS NULL
                AND locked_part.preferred_scout_id IS NOT NULL
                AND locked_part.preferred_scout_id <> ${user.id}
                AND locked_part.preferred_scout_broadcast_at IS NULL
                AND (
                  locked_part.preferred_scout_exclusive_until IS NULL
                  OR locked_part.preferred_scout_exclusive_until > ${now}
                )
            )
        ), assigned AS (
          UPDATE missions AS candidate
          SET scout_id = ${user.id},
              scout_display_name_snapshot = locked_profile.identity_verified_name,
              scout_headshot_path_snapshot = locked_profile.headshot_path,
              scout_identity_verified_at_snapshot = locked_profile.identity_verified_at,
              claimed_at = ${now},
              updated_at = ${now},
              status = CASE
                WHEN candidate.bundle_sequence = target_bundle.active_sequence THEN 'claimed'::mission_status
                ELSE candidate.status
              END
          FROM target_bundle, locked_profile
          WHERE candidate.bundle_id = target_bundle.id
            AND candidate.archived_at IS NULL
            AND candidate.scout_id IS NULL
            AND candidate.status IN ('open', 'draft')
            AND candidate.payment_status = 'paid'
            AND NOT EXISTS (
              SELECT 1
              FROM missions AS invalid
              WHERE invalid.bundle_id = target_bundle.id
                AND invalid.archived_at IS NULL
                AND (invalid.scout_id IS NOT NULL OR invalid.status NOT IN ('open', 'draft'))
            )
          RETURNING candidate.id, candidate.bundle_id
        ), claimed_bundle AS (
          UPDATE mission_bundles AS bundle
          SET status = 'claimed', updated_at = ${now}
          WHERE bundle.id = ${mission.bundleId}
            AND bundle.status = 'open'
            AND (SELECT COUNT(*) FROM assigned) > 0
            AND (SELECT COUNT(*) FROM assigned) = (
              SELECT COUNT(*) FROM missions AS all_parts
              WHERE all_parts.bundle_id = bundle.id AND all_parts.archived_at IS NULL
          )
          RETURNING bundle.id
        ), audited AS (
          INSERT INTO mission_updates (mission_id, author_id, status, message)
          SELECT assigned.id, ${user.id}, 'claimed'::mission_status,
            CASE
              WHEN assigned.id = ${mission.id} THEN 'A Scout claimed the complete mission itinerary.'
              ELSE 'This mission part was reserved for the assigned Scout.'
            END
          FROM assigned
          WHERE EXISTS (SELECT 1 FROM claimed_bundle)
          RETURNING mission_id
        ), notification_checkpoint AS (
          INSERT INTO notifications (
            recipient_user_id, mission_id, channel, status, kind, dedupe_key,
            title, body, action_label, action_url, sent_at
          )
          SELECT ${claimNotification.recipientUserId}, ${id},
            'in_app'::notification_channel, 'sent'::notification_status,
            ${claimNotification.kind}, ${claimNotificationDedupeKey},
            ${claimNotification.title}, ${claimNotification.body},
            ${claimNotification.actionLabel}, ${claimNotification.actionUrl}, ${now}
          WHERE EXISTS (SELECT 1 FROM claimed_bundle)
            AND (SELECT COUNT(*) FROM audited) = (SELECT COUNT(*) FROM assigned)
          ON CONFLICT (dedupe_key) DO NOTHING
          RETURNING dedupe_key
        )
        SELECT CASE
          WHEN (SELECT COUNT(*) FROM claimed_bundle) = 1
            AND (SELECT COUNT(*) FROM audited) = (SELECT COUNT(*) FROM assigned)
            AND (
              EXISTS (
                SELECT 1 FROM notification_checkpoint
                WHERE notification_checkpoint.dedupe_key = ${claimNotificationDedupeKey}
              )
              OR EXISTS (
                SELECT 1 FROM notifications AS existing_checkpoint
                WHERE existing_checkpoint.dedupe_key = ${claimNotificationDedupeKey}
                  AND existing_checkpoint.recipient_user_id = ${claimNotification.recipientUserId}
                  AND existing_checkpoint.mission_id = ${id}
                  AND existing_checkpoint.channel = 'in_app'
                  AND existing_checkpoint.status = 'sent'
                  AND existing_checkpoint.kind = ${claimNotification.kind}
              )
            )
          THEN (SELECT id::text FROM claimed_bundle)
          ELSE (1 / ((SELECT COUNT(*)::integer FROM audited) - (SELECT COUNT(*)::integer FROM audited)))::text
        END AS id
        `);
        claimedBundle = claimedBundleResult.rows[0];
      } catch {
        throw new Error("Another Scout claimed this mission first.");
      }
      if (!claimedBundle?.id) throw new Error("Another Scout claimed this mission first.");
    } else {
      const claimedResult = await db.execute<{ id: string }>(sql`
        WITH locked_user AS MATERIALIZED (
          SELECT claim_user.id
          FROM users AS claim_user
          WHERE claim_user.id = ${user.id}
            AND claim_user.role = 'scout'
            AND claim_user.status = 'active'
            AND claim_user.legal_version = ${LEGAL_VERSION}
            AND claim_user.legal_accepted_at IS NOT NULL
            AND btrim(COALESCE(claim_user.first_name, '')) <> ''
            AND btrim(COALESCE(claim_user.last_name, '')) <> ''
            AND length(regexp_replace(COALESCE(claim_user.phone, ''), '\\D', '', 'g')) >= 10
          FOR UPDATE
        ), locked_profile AS MATERIALIZED (
          UPDATE scout_profiles AS approved_profile
          SET updated_at = approved_profile.updated_at
          WHERE approved_profile.user_id = ${user.id}
            AND approved_profile.status = 'approved'
            AND approved_profile.identity_check = 'clear'
            AND approved_profile.identity_provider IN ('stripe_connect_v1', 'stripe_connect_v2')
            AND approved_profile.identity_verification_reference IS NOT NULL
            AND btrim(approved_profile.identity_verification_reference) <> ''
            AND approved_profile.identity_verified_by IS NULL
            AND approved_profile.identity_verified_name IS NOT NULL
            AND btrim(approved_profile.identity_verified_name) <> ''
            AND approved_profile.identity_verified_at IS NOT NULL
            AND approved_profile.verification_consented_at IS NOT NULL
            AND approved_profile.headshot_path IS NOT NULL
            AND approved_profile.home_zip ~ '^[0-9]{5}$'
            AND approved_profile.service_radius_miles IN (10, 25, 50, 75)
            AND btrim(COALESCE(approved_profile.vehicle_type, '')) <> ''
            AND (approved_profile.can_see OR approved_profile.can_move OR approved_profile.can_meet)
            AND approved_profile.handbook_version = ${SCOUT_HANDBOOK_VERSION}
            AND approved_profile.handbook_accepted_at IS NOT NULL
            AND approved_profile.home_zip IS NOT DISTINCT FROM ${profile.homeZip}
            AND approved_profile.service_radius_miles = ${profile.serviceRadiusMiles}
            AND approved_profile.vehicle_type IS NOT DISTINCT FROM ${profile.vehicleType}
            AND approved_profile.can_see = ${profile.canSee}
            AND approved_profile.can_move = ${profile.canMove}
            AND approved_profile.can_meet = ${profile.canMeet}
            AND approved_profile.stripe_account_id IS NOT NULL
            AND approved_profile.stripe_account_api_version IS NOT NULL
            AND (
              (approved_profile.stripe_account_api_version = 'v1' AND approved_profile.identity_provider = 'stripe_connect_v1')
              OR (approved_profile.stripe_account_api_version = 'v2' AND approved_profile.identity_provider = 'stripe_connect_v2')
            )
            AND approved_profile.stripe_account_livemode = ${stripeLivemode}
            AND approved_profile.stripe_sync_completed_generation = approved_profile.stripe_sync_generation
            AND approved_profile.stripe_connect_status = 'ready'
            AND approved_profile.stripe_details_submitted = TRUE
            AND approved_profile.stripe_transfers_active = TRUE
            AND approved_profile.payouts_enabled = TRUE
            AND approved_profile.stripe_onboarding_completed_at IS NOT NULL
            AND approved_profile.stripe_payout_schedule_configured_at IS NOT NULL
            AND jsonb_array_length(approved_profile.stripe_requirements_currently_due) = 0
            AND jsonb_array_length(approved_profile.stripe_requirements_past_due) = 0
            AND jsonb_array_length(approved_profile.stripe_requirements_pending_verification) = 0
            AND EXISTS (SELECT 1 FROM locked_user WHERE locked_user.id = approved_profile.user_id)
          RETURNING approved_profile.identity_verified_name, approved_profile.headshot_path, approved_profile.identity_verified_at
        ), claimed_mission AS (
          UPDATE missions AS candidate
          SET scout_id = ${user.id},
              scout_display_name_snapshot = locked_profile.identity_verified_name,
              scout_headshot_path_snapshot = locked_profile.headshot_path,
              scout_identity_verified_at_snapshot = locked_profile.identity_verified_at,
              status = 'claimed',
              claimed_at = ${now},
              updated_at = ${now}
          FROM locked_profile
          WHERE candidate.id = ${id}
            AND candidate.status = 'open'
            AND candidate.payment_status = 'paid'
            AND candidate.scout_id IS NULL
            AND candidate.archived_at IS NULL
            AND (
              candidate.preferred_scout_id IS NULL
              OR candidate.preferred_scout_id = ${user.id}
              OR candidate.preferred_scout_broadcast_at IS NOT NULL
              OR (
                candidate.preferred_scout_exclusive_until IS NOT NULL
                AND candidate.preferred_scout_exclusive_until <= ${now}
              )
            )
          RETURNING candidate.id
        ), audited AS (
          INSERT INTO mission_updates (mission_id, author_id, status, message)
          SELECT claimed_mission.id, ${user.id}, 'claimed'::mission_status, 'A Scout claimed this mission.'
          FROM claimed_mission
          RETURNING mission_id
        ), notification_checkpoint AS (
          INSERT INTO notifications (
            recipient_user_id, mission_id, channel, status, kind, dedupe_key,
            title, body, action_label, action_url, sent_at
          )
          SELECT ${claimNotification.recipientUserId}, ${id},
            'in_app'::notification_channel, 'sent'::notification_status,
            ${claimNotification.kind}, ${claimNotificationDedupeKey},
            ${claimNotification.title}, ${claimNotification.body},
            ${claimNotification.actionLabel}, ${claimNotification.actionUrl}, ${now}
          WHERE EXISTS (SELECT 1 FROM audited)
          ON CONFLICT (dedupe_key) DO NOTHING
          RETURNING dedupe_key
        )
        SELECT claimed_mission.id::text
        FROM claimed_mission
        WHERE (SELECT COUNT(*) FROM audited) = 1
          AND (
            EXISTS (
              SELECT 1 FROM notification_checkpoint
              WHERE notification_checkpoint.dedupe_key = ${claimNotificationDedupeKey}
            )
            OR EXISTS (
              SELECT 1 FROM notifications AS existing_checkpoint
              WHERE existing_checkpoint.dedupe_key = ${claimNotificationDedupeKey}
                AND existing_checkpoint.recipient_user_id = ${claimNotification.recipientUserId}
                AND existing_checkpoint.mission_id = ${id}
                AND existing_checkpoint.channel = 'in_app'
                AND existing_checkpoint.status = 'sent'
                AND existing_checkpoint.kind = ${claimNotification.kind}
            )
          )
      `);
      if (!claimedResult.rows[0]?.id) throw new Error("The mission or your Scout approval changed in another window.");
    }

    // The claim and its audit trail are authoritative at this point. Queue the
    // customer notice through the durable, idempotent notification path, but
    // never tell the Scout that a committed claim failed because a provider or
    // cache refresh was temporarily unavailable.
    try {
      await notifyUserOnce(claimNotification);
    } catch (error) {
      await reportException(error, { route: "missions.claim_notification", missionId: id });
    }
    try {
      refreshMission(id);
    } catch (error) {
      await reportException(error, { route: "missions.claim_revalidation", missionId: id });
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to claim this mission." };
  }
}

export async function updateMissionStatus(id: string, nextStatus: MissionStatus): Promise<Result> {
  try {
    const user = await requireAppUser("scout");
    const mission = await getMission(id);
    if (mission.scoutId !== user.id) throw new Error("Only the assigned Scout can update this mission.");
    await requireActiveBundleLeg(mission);
    const transitions: Record<string, MissionStatus[]> = mission.type === "move"
      ? {
          claimed: ["en_route_pickup"],
          en_route_pickup: ["at_pickup"],
          at_pickup: ["en_route_dropoff"],
          en_route_dropoff: ["at_dropoff"],
        }
      : {
          claimed: ["en_route"],
          en_route: ["onsite"],
        };
    if (!transitions[mission.status]?.includes(nextStatus)) throw new Error("That status change is not available yet.");

    const terminal = nextStatus === "submitted";
    const now = new Date();
    if (mission.type === "meet") {
      if (!mission.scheduledFor) throw new Error("This appointment does not have a scheduled start time.");
      if (nextStatus === "en_route" && !meetActionIsAvailable(mission.scheduledFor, "en_route", now)) {
        throw new Error(`Travel status opens 30 minutes before the appointment, at ${formatDateTime(meetActionOpensAt(mission.scheduledFor, "en_route"), mission.timezone)}.`);
      }
      if (nextStatus === "onsite" && !meetActionIsAvailable(mission.scheduledFor, "onsite", now)) {
        throw new Error(`Verified check-in opens five minutes before the appointment, at ${formatDateTime(meetActionOpensAt(mission.scheduledFor, "onsite"), mission.timezone)}.`);
      }
    }
    let verifiedArrival: ReturnType<typeof verifyScoutAtLocation> | null = null;
    if (nextStatus === "at_pickup" && mission.pickupLatitude && mission.pickupLongitude) verifiedArrival = verifyScoutAtLocation(mission, mission.pickupLatitude, mission.pickupLongitude);
    if (nextStatus === "at_dropoff" && mission.dropoffLatitude && mission.dropoffLongitude) verifiedArrival = verifyScoutAtLocation(mission, mission.dropoffLatitude, mission.dropoffLongitude);
    if (nextStatus === "onsite" && mission.pickupLatitude && mission.pickupLongitude) {
      verifiedArrival = verifyScoutAtLocation(mission, mission.pickupLatitude, mission.pickupLongitude);
    }
    const [updated] = await getDb().update(missions).set({
      status: nextStatus,
      billableStartedAt: mission.type === "meet" && nextStatus === "onsite" && verifiedArrival ? now : mission.billableStartedAt,
      billableLastVerifiedAt: mission.type === "meet" && nextStatus === "onsite" && verifiedArrival ? now : mission.billableLastVerifiedAt,
      verifiedCheckInAt: verifiedArrival && ["at_pickup", "onsite"].includes(nextStatus) ? now : mission.verifiedCheckInAt,
      verifiedCheckInLatitude: verifiedArrival && ["at_pickup", "onsite"].includes(nextStatus) ? verifiedArrival.latitude : mission.verifiedCheckInLatitude,
      verifiedCheckInLongitude: verifiedArrival && ["at_pickup", "onsite"].includes(nextStatus) ? verifiedArrival.longitude : mission.verifiedCheckInLongitude,
      verifiedCheckInAccuracyMeters: verifiedArrival && ["at_pickup", "onsite"].includes(nextStatus) ? verifiedArrival.accuracy : mission.verifiedCheckInAccuracyMeters,
      verifiedCheckOutAt: verifiedArrival && nextStatus === "at_dropoff" ? now : mission.verifiedCheckOutAt,
      verifiedCheckOutLatitude: verifiedArrival && nextStatus === "at_dropoff" ? verifiedArrival.latitude : mission.verifiedCheckOutLatitude,
      verifiedCheckOutLongitude: verifiedArrival && nextStatus === "at_dropoff" ? verifiedArrival.longitude : mission.verifiedCheckOutLongitude,
      verifiedCheckOutAccuracyMeters: verifiedArrival && nextStatus === "at_dropoff" ? verifiedArrival.accuracy : mission.verifiedCheckOutAccuracyMeters,
      locationSharingActive: terminal ? false : mission.locationSharingActive,
      scoutLatitude: terminal ? null : mission.scoutLatitude,
      scoutLongitude: terminal ? null : mission.scoutLongitude,
      scoutLocationAccuracyMeters: terminal ? null : mission.scoutLocationAccuracyMeters,
      scoutLocationUpdatedAt: terminal ? null : mission.scoutLocationUpdatedAt,
      updatedAt: now,
    }).where(and(
      eq(missions.id, id),
      eq(missions.scoutId, user.id),
      eq(missions.status, mission.status),
      isNull(missions.archivedAt),
    )).returning({ id: missions.id });
    if (!updated) throw new Error("The mission changed in another window. Refresh before trying again.");
    await getDb().insert(missionUpdates).values({ missionId: id, authorId: user.id, status: nextStatus });
    await notifyUser({ recipientUserId: mission.customerId, missionId: id, kind: "status_update", title: "Mission status updated", body: statusLabel(mission.type, nextStatus), actionLabel: "View live mission", actionUrl: `https://sendascout.com/dashboard/missions/${id}` });
    refreshMission(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to update this mission." };
  }
}

export async function submitMissionResults(
  id: string,
  summary: string,
  mediaUrls: string[],
  deliveryProofUrls: string[] = [],
  checklistResponses: MissionChecklistResponseInput[] = [],
): Promise<Result> {
  try {
    const user = await requireAppUser("scout");
    const mission = await getMission(id);
    if (mission.scoutId !== user.id) throw new Error("Only the assigned Scout can submit results.");
    const bundleContext = await requireActiveBundleLeg(mission);
    const ready = mission.type === "move" ? mission.status === "at_dropoff" : mission.status === "onsite";
    if (!ready) throw new Error("Finish the mission steps before submitting results.");
    const [acceptedUnpaidOrder] = await getDb().select({ id: missionChangeOrders.id }).from(missionChangeOrders).where(and(
      eq(missionChangeOrders.missionId, id),
      eq(missionChangeOrders.status, "pending"),
      sql`${missionChangeOrders.approvedByUserId} IS NOT NULL`,
    )).limit(1);
    if (acceptedUnpaidOrder) throw new Error("Customer payment for an accepted additional task must clear before results can be submitted.");
    if (mission.deliveryPinRequired && !mission.deliveryPinVerifiedAt) {
      throw new Error("Verify the recipient’s delivery PIN before submitting this delivery.");
    }

    const cleanSummary = summary.trim();
    const proofPaths = uniqueMissionPaths(id, deliveryProofUrls);
    const generalPaths = uniqueMissionPaths(id, mediaUrls).filter((pathname) => !proofPaths.includes(pathname));
    const checklistPaths = uniqueMissionPaths(id, checklistResponses.flatMap((response) => response.mediaUrls ?? []));
    const allPaths = [...new Set([...proofPaths, ...generalPaths, ...checklistPaths])];
    if (allPaths.length > maxResultFileCount) throw new Error(`Mission evidence is limited to ${maxResultFileCount} files per submission.`);
    if (!cleanSummary && allPaths.length === 0 && checklistResponses.length === 0) throw new Error("Add a written result, photo, video, or checklist response before submitting.");
    if (cleanSummary.length > 5000) throw new Error("Result notes are limited to 5,000 characters.");
    if (mission.proofOfDeliveryRequired && proofPaths.length === 0) throw new Error("Add a delivery photo before submitting this Move It mission.");

    const blobMetadata = await verifiedBlobMetadata(allPaths);
    if (blobMetadata.reduce((total, item) => total + item.byteSize, 0) > maxResultTotalSize) {
      throw new Error("Mission evidence is limited to 250 MB per submission.");
    }
    const metadataByPath = new Map(blobMetadata.map((item) => [item.pathname, item]));
    for (const pathname of proofPaths) {
      const metadata = metadataByPath.get(pathname);
      if (!metadata || !isVerifiedDeliveryPhoto({ kind: "delivery_photo", contentType: metadata.contentType, byteSize: metadata.byteSize })) {
        throw new Error("Proof of delivery must be a valid JPG, PNG, or WEBP photo.");
      }
      await verifyDeliveryPhotoContent(pathname, metadata.contentType);
    }

    const db = getDb();
    const now = new Date();
    const [checklistItems, acceptedChanges] = await Promise.all([
      db.select().from(missionChecklistItems).where(eq(missionChecklistItems.missionId, id)).orderBy(asc(missionChecklistItems.sequence)),
      acceptedChangeOrderTotals(id),
    ]);
    const responseByItem = new Map(checklistResponses.map((response) => [response.itemId, response]));
    const normalizedChecklistResponses = checklistItems.flatMap((item) => {
      const response = responseByItem.get(item.id);
      const responseText = response?.responseText?.trim() ?? "";
      const responseMedia = uniqueMissionPaths(id, response?.mediaUrls ?? []);
      const imageMedia = responseMedia.filter((pathname) => metadataByPath.get(pathname)?.contentType.startsWith("image/"));
      const videoMedia = responseMedia.filter((pathname) => metadataByPath.get(pathname)?.contentType.startsWith("video/"));
      const complete = item.responseType === "check"
        ? responseText === "yes" || responseText === "no"
        : item.responseType === "text"
          ? responseText.length > 0
          : item.responseType === "number"
            ? responseText.length > 0 && Number.isFinite(Number(responseText))
            : item.responseType === "photo"
              ? imageMedia.length > 0
              : videoMedia.length > 0;
      if (item.required && !complete) throw new Error(`Complete the required report item: ${item.prompt}`);
      if (!complete) return [];
      return [{ item, responseText: responseText || (item.responseType === "check" ? "yes" : ""), media: item.responseType === "photo" ? imageMedia : item.responseType === "video" ? videoMedia : [] }];
    });

    let billingChanges: Partial<typeof missions.$inferInsert> = {};
    if (mission.type === "meet" && mission.pickupLatitude && mission.pickupLongitude) {
      if (!mission.billableStartedAt) throw new Error("Verified appointment time has not started.");
      const lastVerifiedAt = mission.billableLastVerifiedAt ?? mission.billableStartedAt;
      const verifiedEndMs = mission.billableEndedAt?.getTime() ?? Math.min(
          now.getTime(),
          lastVerifiedAt.getTime() + 60_000,
          mission.billableStartedAt.getTime() + mission.meetAuthorizedMinutes * 60_000,
        );
      const billableMinutes = mission.billableMinutes
        ?? Math.max(1, Math.ceil((verifiedEndMs - mission.billableStartedAt.getTime()) / 60_000));
      const chargedMinutes = mission.chargedMinutes
        ?? Math.min(mission.meetAuthorizedMinutes, Math.max(60, Math.ceil(billableMinutes / 15) * 15));
      const finalPrice = meetPriceForMinutes(chargedMinutes);
      const reportCustomerCents = mission.enhancedReportRequested ? enhancedReportCustomerCents : 0;
      const reportScoutCents = mission.enhancedReportRequested ? enhancedReportScoutCents : 0;
      billingChanges = {
        billableEndedAt: new Date(verifiedEndMs),
        billableMinutes,
        chargedMinutes,
        customerPriceCents: finalPrice.customer + reportCustomerCents + acceptedChanges.customerCents - mission.bundleDiscountCents,
        scoutPayoutCents: finalPrice.scout + reportScoutCents + acceptedChanges.scoutCents,
        platformFeeCents: finalPrice.customer - finalPrice.scout
          + reportCustomerCents - reportScoutCents + acceptedChanges.platformCents - mission.bundleDiscountCents,
        verifiedCheckOutAt: new Date(verifiedEndMs),
      };
    }

    const evidenceKinds = new Map<string, "general_result" | "delivery_photo" | "checklist_photo" | "checklist_video">();
    for (const pathname of generalPaths) evidenceKinds.set(pathname, "general_result");
    for (const pathname of proofPaths) evidenceKinds.set(pathname, "delivery_photo");
    for (const response of normalizedChecklistResponses) {
      for (const pathname of response.media) {
        if (!evidenceKinds.has(pathname)) evidenceKinds.set(pathname, response.item.responseType === "photo" ? "checklist_photo" : "checklist_video");
      }
    }
    const evidenceValues = [...evidenceKinds].map(([storagePath, kind]) => {
      const metadata = metadataByPath.get(storagePath)!;
      const checklistItemId = normalizedChecklistResponses.find((response) => response.media.includes(storagePath))?.item.id ?? null;
      return {
        missionId: id,
        checklistItemId,
        uploadedByUserId: user.id,
        kind,
        storagePath,
        contentType: metadata.contentType,
        byteSize: metadata.byteSize,
        customerVisible: true,
      };
    });
    const nextLeg = bundleContext?.legs.find((leg) => leg.bundleSequence === (mission.bundleSequence ?? 0) + 1) ?? null;
    const resultTimelineStatus: MissionStatus = bundleContext && nextLeg ? "completed" : "submitted";

    const persistence: [BatchItem<"pg">, ...BatchItem<"pg">[]] = [
      db.insert(missionUpdates).values({
        missionId: id,
        authorId: user.id,
        status: resultTimelineStatus,
        message: cleanSummary || "Scout submitted mission evidence.",
      }),
      db.insert(missionPartResults).values({
        missionId: id,
        status: "submitted",
        summary: cleanSummary || null,
        submittedByUserId: user.id,
        submittedAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: missionPartResults.missionId,
        set: { status: "submitted", summary: cleanSummary || null, submittedByUserId: user.id, submittedAt: now, updatedAt: now },
      }),
      db.update(missionChangeOrders).set({
        status: "fulfilled",
        fulfilledAt: now,
        updatedAt: now,
      }).where(and(eq(missionChangeOrders.missionId, id), eq(missionChangeOrders.status, "approved"))),
      ...normalizedChecklistResponses.map((response) => db.update(missionChecklistItems).set({
        responseText: response.responseText || null,
        completedByUserId: user.id,
        completedAt: now,
        updatedAt: now,
      }).where(and(eq(missionChecklistItems.id, response.item.id), eq(missionChecklistItems.missionId, id)))),
    ];
    if (evidenceValues.length) {
      persistence.push(db.insert(missionEvidence).values(evidenceValues).onConflictDoNothing({ target: missionEvidence.storagePath }));
      persistence.push(db.insert(missionUpdates).values(evidenceValues.map((evidence) => ({
        missionId: id,
        authorId: user.id,
        status: resultTimelineStatus,
        mediaUrl: evidence.storagePath,
        evidenceKind: evidence.kind,
      }))));
    }
    const expectedStatus = mission.status;
    const finalizedCustomerPriceCents = Number(billingChanges.customerPriceCents ?? mission.customerPriceCents);
    const previousListCustomerPriceCents = mission.listCustomerPriceCents ?? mission.customerPriceCents + mission.bundleDiscountCents;
    const finalizedListCustomerPriceCents = finalizedCustomerPriceCents + mission.bundleDiscountCents;
    const finalizedScoutPayoutCents = Number(billingChanges.scoutPayoutCents ?? mission.scoutPayoutCents);
    const finalizedPlatformFeeCents = Number(billingChanges.platformFeeCents ?? mission.platformFeeCents);
    const bundleListCustomerDeltaCents = finalizedListCustomerPriceCents - previousListCustomerPriceCents;
    const bundleCustomerDeltaCents = finalizedCustomerPriceCents - mission.customerPriceCents;
    const bundleScoutDeltaCents = finalizedScoutPayoutCents - mission.scoutPayoutCents;
    const bundlePlatformDeltaCents = finalizedPlatformFeeCents - mission.platformFeeCents;
    if (mission.type === "meet") {
      if (bundleCustomerDeltaCents < 0 || bundleScoutDeltaCents < 0 || bundlePlatformDeltaCents < 0) {
        throw new Error("The finalized appointment price does not match the paid booking. Contact support before submitting results.");
      }
      if (bundleCustomerDeltaCents > 0) {
        if (!billingChanges.billableEndedAt || !billingChanges.billableMinutes || !billingChanges.chargedMinutes) {
          throw new Error("The verified appointment billing snapshot is incomplete.");
        }
        if (!mission.billableEndedAt) {
          const [frozen] = await db.update(missions).set({
            billableEndedAt: billingChanges.billableEndedAt,
            billableMinutes: Number(billingChanges.billableMinutes),
            chargedMinutes: Number(billingChanges.chargedMinutes),
            verifiedCheckOutAt: billingChanges.verifiedCheckOutAt ?? billingChanges.billableEndedAt,
            locationSharingActive: false,
            scoutLatitude: null,
            scoutLongitude: null,
            scoutLocationAccuracyMeters: null,
            scoutLocationUpdatedAt: null,
            updatedAt: now,
          }).where(and(
            eq(missions.id, id),
            eq(missions.scoutId, user.id),
            eq(missions.status, mission.status),
            isNull(missions.billableEndedAt),
            isNull(missions.archivedAt),
          )).returning({ id: missions.id });
          if (!frozen) throw new Error("The appointment billing snapshot changed. Refresh before submitting again.");
        }

        const adjustment = await ensureAddonPayment({
          kind: "meet_adjustment",
          missionId: id,
          customerId: mission.customerId,
          amountCents: bundleCustomerDeltaCents,
          scoutPayoutCents: bundleScoutDeltaCents,
        });
        const paymentAttempt = await attemptSavedPayment(adjustment.id);
        if (paymentAttempt.state !== "paid") {
          await notifyUser({
            recipientUserId: mission.customerId,
            missionId: id,
            kind: "meet_adjustment_payment_required",
            title: "Appointment payment confirmation required",
            body: `Confirm the additional $${(bundleCustomerDeltaCents / 100).toFixed(2)} for verified appointment time before the Scout can submit results.`,
            actionLabel: "Open payments",
            actionUrl: "https://sendascout.com/dashboard/customer/payments",
          });
          throw new Error("Verified appointment time is saved, but customer payment must clear before results can be submitted.");
        }
      }
    }
    let resultNotification: Parameters<typeof notifyUser>[0];
    let additionalRefreshId: string | null = null;
    let transitionQuery: BatchItem<"pg">;
    if (bundleContext && nextLeg) {
      transitionQuery = db.execute<{ id: string }>(sql`
        WITH finished AS (
          UPDATE missions AS current_part
          SET status = 'completed',
              completed_at = ${now},
              submitted_at = ${now},
              billable_ended_at = ${billingChanges.billableEndedAt ?? mission.billableEndedAt},
              billable_minutes = ${billingChanges.billableMinutes ?? mission.billableMinutes},
              charged_minutes = ${billingChanges.chargedMinutes ?? mission.chargedMinutes},
              customer_price_cents = ${finalizedCustomerPriceCents},
              list_customer_price_cents = ${finalizedListCustomerPriceCents},
              scout_payout_cents = ${finalizedScoutPayoutCents},
              platform_fee_cents = ${finalizedPlatformFeeCents},
              verified_check_out_at = ${billingChanges.verifiedCheckOutAt ?? mission.verifiedCheckOutAt},
              location_sharing_active = false,
              scout_latitude = NULL,
              scout_longitude = NULL,
              scout_location_accuracy_meters = NULL,
              scout_location_updated_at = NULL,
              updated_at = ${now}
          WHERE current_part.id = ${id}
            AND current_part.scout_id = ${user.id}
            AND current_part.status = ${expectedStatus}
            AND current_part.customer_price_cents = ${mission.customerPriceCents}
            AND current_part.scout_payout_cents = ${mission.scoutPayoutCents}
            AND current_part.platform_fee_cents = ${mission.platformFeeCents}
            AND current_part.archived_at IS NULL
            AND EXISTS (
              SELECT 1 FROM mission_bundles AS bundle
              WHERE bundle.id = current_part.bundle_id
                AND bundle.active_sequence = current_part.bundle_sequence
                AND bundle.status IN ('claimed', 'in_progress')
            )
            AND EXISTS (
              SELECT 1 FROM missions AS next_part
              WHERE next_part.bundle_id = current_part.bundle_id
                AND next_part.bundle_sequence = current_part.bundle_sequence + 1
                AND next_part.scout_id = ${user.id}
                AND next_part.status = 'draft'
                AND next_part.archived_at IS NULL
            )
          RETURNING current_part.bundle_id, current_part.bundle_sequence
        ), activated AS (
          UPDATE missions AS next_part
          SET status = 'claimed', claimed_at = COALESCE(next_part.claimed_at, ${now}), updated_at = ${now}
          FROM finished
          WHERE next_part.bundle_id = finished.bundle_id
            AND next_part.bundle_sequence = finished.bundle_sequence + 1
            AND next_part.scout_id = ${user.id}
            AND next_part.status = 'draft'
            AND next_part.archived_at IS NULL
          RETURNING next_part.bundle_id, next_part.bundle_sequence
        ), progressed_bundle AS (
          UPDATE mission_bundles AS bundle
          SET active_sequence = activated.bundle_sequence,
              status = 'in_progress',
              list_customer_price_cents = bundle.list_customer_price_cents + ${bundleListCustomerDeltaCents},
              customer_price_cents = bundle.customer_price_cents + ${bundleCustomerDeltaCents},
              scout_payout_cents = bundle.scout_payout_cents + ${bundleScoutDeltaCents},
              platform_fee_cents = bundle.platform_fee_cents + ${bundlePlatformDeltaCents},
              updated_at = ${now}
          FROM activated
          WHERE bundle.id = activated.bundle_id
            AND bundle.active_sequence = ${mission.bundleSequence}
            AND bundle.status IN ('claimed', 'in_progress')
          RETURNING bundle.id
        )
        SELECT CASE
          WHEN (SELECT COUNT(*) FROM progressed_bundle) = 1
          THEN (SELECT id::text FROM progressed_bundle)
          ELSE (1 / ((SELECT COUNT(*)::integer FROM progressed_bundle) - (SELECT COUNT(*)::integer FROM progressed_bundle)))::text
        END AS id
      `);
      resultNotification = { recipientUserId: mission.customerId, missionId: nextLeg.id, kind: "bundle_part_ready", title: "The next mission part is ready", body: `Your Scout completed part ${mission.bundleSequence} of ${bundleContext.legs.length} and can now begin the next part.`, actionLabel: "Track next part", actionUrl: `https://sendascout.com/dashboard/missions/${nextLeg.id}` };
      additionalRefreshId = nextLeg.id;
    } else if (bundleContext) {
      transitionQuery = db.execute<{ id: string }>(sql`
        WITH submitted_part AS (
          UPDATE missions AS current_part
          SET status = 'submitted',
              submitted_at = ${now},
              billable_ended_at = ${billingChanges.billableEndedAt ?? mission.billableEndedAt},
              billable_minutes = ${billingChanges.billableMinutes ?? mission.billableMinutes},
              charged_minutes = ${billingChanges.chargedMinutes ?? mission.chargedMinutes},
              customer_price_cents = ${finalizedCustomerPriceCents},
              list_customer_price_cents = ${finalizedListCustomerPriceCents},
              scout_payout_cents = ${finalizedScoutPayoutCents},
              platform_fee_cents = ${finalizedPlatformFeeCents},
              verified_check_out_at = ${billingChanges.verifiedCheckOutAt ?? mission.verifiedCheckOutAt},
              location_sharing_active = false,
              scout_latitude = NULL,
              scout_longitude = NULL,
              scout_location_accuracy_meters = NULL,
              scout_location_updated_at = NULL,
              updated_at = ${now}
          WHERE current_part.id = ${id}
            AND current_part.scout_id = ${user.id}
            AND current_part.status = ${expectedStatus}
            AND current_part.customer_price_cents = ${mission.customerPriceCents}
            AND current_part.scout_payout_cents = ${mission.scoutPayoutCents}
            AND current_part.platform_fee_cents = ${mission.platformFeeCents}
            AND current_part.archived_at IS NULL
            AND EXISTS (
              SELECT 1 FROM mission_bundles AS bundle
              WHERE bundle.id = current_part.bundle_id
                AND bundle.active_sequence = current_part.bundle_sequence
                AND bundle.status IN ('claimed', 'in_progress')
            )
          RETURNING current_part.bundle_id
        ), submitted_bundle AS (
          UPDATE mission_bundles AS bundle
          SET status = 'submitted',
              submitted_at = ${now},
              list_customer_price_cents = bundle.list_customer_price_cents + ${bundleListCustomerDeltaCents},
              customer_price_cents = bundle.customer_price_cents + ${bundleCustomerDeltaCents},
              scout_payout_cents = bundle.scout_payout_cents + ${bundleScoutDeltaCents},
              platform_fee_cents = bundle.platform_fee_cents + ${bundlePlatformDeltaCents},
              updated_at = ${now}
          FROM submitted_part
          WHERE bundle.id = submitted_part.bundle_id
          RETURNING bundle.id
        )
        SELECT CASE
          WHEN (SELECT COUNT(*) FROM submitted_bundle) = 1
          THEN (SELECT id::text FROM submitted_bundle)
          ELSE (1 / ((SELECT COUNT(*)::integer FROM submitted_bundle) - (SELECT COUNT(*)::integer FROM submitted_bundle)))::text
        END AS id
      `);
      resultNotification = { recipientUserId: mission.customerId, missionId: id, kind: "results_submitted", title: mission.type === "move" ? "Delivery results are ready" : "Mission results are ready", body: "All mission parts are complete. Review the results and confirm completion within 24 hours.", actionLabel: "Review results", actionUrl: `https://sendascout.com/dashboard/missions/${id}` };
    } else {
      transitionQuery = db.execute<{ id: string }>(sql`
        WITH submitted_mission AS (
          UPDATE missions AS current_mission
          SET status = 'submitted',
              submitted_at = ${now},
              billable_ended_at = ${billingChanges.billableEndedAt ?? mission.billableEndedAt},
              billable_minutes = ${billingChanges.billableMinutes ?? mission.billableMinutes},
              charged_minutes = ${billingChanges.chargedMinutes ?? mission.chargedMinutes},
              customer_price_cents = ${finalizedCustomerPriceCents},
              list_customer_price_cents = ${finalizedListCustomerPriceCents},
              scout_payout_cents = ${finalizedScoutPayoutCents},
              platform_fee_cents = ${finalizedPlatformFeeCents},
              verified_check_out_at = ${billingChanges.verifiedCheckOutAt ?? mission.verifiedCheckOutAt},
              location_sharing_active = false,
              scout_latitude = NULL,
              scout_longitude = NULL,
              scout_location_accuracy_meters = NULL,
              scout_location_updated_at = NULL,
              updated_at = ${now}
          WHERE current_mission.id = ${id}
            AND current_mission.scout_id = ${user.id}
            AND current_mission.status = ${expectedStatus}
            AND current_mission.customer_price_cents = ${mission.customerPriceCents}
            AND current_mission.scout_payout_cents = ${mission.scoutPayoutCents}
            AND current_mission.platform_fee_cents = ${mission.platformFeeCents}
            AND current_mission.archived_at IS NULL
          RETURNING current_mission.id
        )
        SELECT CASE
          WHEN (SELECT COUNT(*) FROM submitted_mission) = 1
          THEN (SELECT id::text FROM submitted_mission)
          ELSE (1 / ((SELECT COUNT(*)::integer FROM submitted_mission) - (SELECT COUNT(*)::integer FROM submitted_mission)))::text
        END AS id
      `);
      resultNotification = { recipientUserId: mission.customerId, missionId: id, kind: "results_submitted", title: mission.type === "move" ? "Delivery results are ready" : "Mission results are ready", body: "Your Scout submitted the mission results. Review them and confirm completion within 24 hours.", actionLabel: "Review results", actionUrl: `https://sendascout.com/dashboard/missions/${id}` };
    }
    try {
      await db.batch([transitionQuery, ...persistence]);
    } catch (error) {
      const code = databaseErrorCode(error);
      console.error("Mission result persistence failed", {
        missionId: id,
        expectedStatus,
        errorName: error instanceof Error ? error.name : "UnknownError",
        databaseCode: code ?? "unknown",
      });
      if (code === "22012") {
        throw new Error("The mission changed while results were being submitted. Refresh before continuing.");
      }
      throw new Error("We couldn't submit your results. Please try again. If this continues, contact support.");
    }
    const scoutSubmissionNotification: Parameters<typeof notifyUser>[0] = {
      recipientUserId: user.id,
      missionId: id,
      kind: "results_submission_received",
      title: nextLeg ? "Mission part submitted" : "Results submitted — awaiting review",
      body: nextLeg
        ? "Your results for this mission part were submitted successfully. Continue with the next part. The full mission is not complete, and payout has not been released."
        : "Your results were submitted successfully and are awaiting customer review. The mission is not complete, and payout has not been released.",
      actionLabel: nextLeg ? "Open next mission part" : "View submission",
      actionUrl: `https://sendascout.com/dashboard/missions/${nextLeg?.id ?? id}`,
    };
    await Promise.all([
      notifyUser(resultNotification),
      notifyUser(scoutSubmissionNotification),
    ]);
    if (additionalRefreshId) refreshMission(additionalRefreshId);
    refreshMission(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to submit mission results." };
  }
}

export async function verifyMissionDeliveryPin(id: string, pin: string): Promise<Result> {
  try {
    const user = await requireAppUser("scout");
    const mission = await getMission(id);
    if (mission.scoutId !== user.id || mission.type !== "move" || mission.status !== "at_dropoff") {
      throw new Error("The recipient PIN can be verified only by the assigned Scout at drop-off.");
    }
    await requireActiveBundleLeg(mission);
    if (!mission.deliveryPinRequired || !mission.deliveryPinHash) throw new Error("This delivery does not require a recipient PIN.");
    if (mission.deliveryPinVerifiedAt) return { ok: true };
    const now = new Date();
    if (isDeliveryPinLocked(mission.deliveryPinLockedUntil, now)) {
      throw new Error(`PIN entry is temporarily locked until ${formatDateTime(mission.deliveryPinLockedUntil!, mission.timezone)}. Contact support if the recipient cannot provide the code.`);
    }
    const pepper = process.env.DELIVERY_PIN_SECRET?.trim();
    if (!pepper) throw new Error("Delivery PIN verification is not configured. Contact support before completing this delivery.");

    const matches = deliveryPinMatches(pin, mission.deliveryPinHash, pepper, mission.id);
    if (!matches) {
      const currentAttempts = mission.deliveryPinLockedUntil && mission.deliveryPinLockedUntil.getTime() <= now.getTime()
        ? 0
        : mission.deliveryPinFailedAttempts;
      const failure = nextDeliveryPinFailureState(currentAttempts, now);
      const [recorded] = await getDb().update(missions).set({
        deliveryPinFailedAttempts: failure.failedAttempts,
        deliveryPinLockedUntil: failure.lockedUntil,
        updatedAt: now,
      }).where(and(
        eq(missions.id, id),
        eq(missions.scoutId, user.id),
        eq(missions.status, "at_dropoff"),
        eq(missions.deliveryPinFailedAttempts, mission.deliveryPinFailedAttempts),
        isNull(missions.deliveryPinVerifiedAt),
        isNull(missions.archivedAt),
      )).returning({ id: missions.id });
      if (!recorded) throw new Error("PIN status changed in another window. Refresh before trying again.");
      if (failure.lockedUntil) throw new Error("Too many incorrect PIN attempts. PIN entry is locked for 15 minutes; use mission support if the recipient needs help.");
      throw new Error(`That PIN did not match. ${5 - failure.failedAttempts} attempt${5 - failure.failedAttempts === 1 ? "" : "s"} remain before a temporary lock.`);
    }

    const [verified] = await getDb().update(missions).set({
      deliveryPinVerifiedAt: now,
      deliveryPinVerifiedBy: user.id,
      deliveryPinFailedAttempts: 0,
      deliveryPinLockedUntil: null,
      updatedAt: now,
    }).where(and(
      eq(missions.id, id),
      eq(missions.scoutId, user.id),
      eq(missions.status, "at_dropoff"),
      eq(missions.deliveryPinFailedAttempts, mission.deliveryPinFailedAttempts),
      isNull(missions.deliveryPinVerifiedAt),
      isNull(missions.archivedAt),
    )).returning({ id: missions.id });
    if (!verified) throw new Error("PIN status changed in another window. Refresh before trying again.");
    await getDb().insert(missionUpdates).values({ missionId: id, authorId: user.id, status: "at_dropoff", message: "Recipient delivery PIN verified." });
    await notifyUser({ recipientUserId: mission.customerId, missionId: id, kind: "delivery_pin_verified", title: "Recipient PIN confirmed", body: "The recipient provided the delivery PIN to your Scout at drop-off.", actionLabel: "View delivery", actionUrl: `https://sendascout.com/dashboard/missions/${id}` });
    refreshMission(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to verify the recipient PIN." };
  }
}

export async function setLocationSharing(id: string, active: boolean): Promise<Result> {
  try {
    const user = await requireAppUser("scout");
    const mission = await getMission(id);
    if (mission.scoutId !== user.id || !activeStatuses.includes(mission.status)) throw new Error("Location sharing is available only on your active mission.");
    await requireActiveBundleLeg(mission);
    const [updated] = await getDb().update(missions).set({
      locationSharingActive: active,
      scoutLatitude: active ? mission.scoutLatitude : null,
      scoutLongitude: active ? mission.scoutLongitude : null,
      scoutLocationAccuracyMeters: active ? mission.scoutLocationAccuracyMeters : null,
      scoutLocationUpdatedAt: active ? mission.scoutLocationUpdatedAt : null,
      updatedAt: new Date(),
    }).where(and(
      eq(missions.id, id),
      eq(missions.scoutId, user.id),
      eq(missions.status, mission.status),
      eq(missions.locationSharingActive, mission.locationSharingActive),
      isNull(missions.archivedAt),
    )).returning({ id: missions.id });
    if (!updated) throw new Error("The mission changed in another window. Refresh before trying again.");
    refreshMission(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to change location sharing." };
  }
}

export async function updateMissionLocation(id: string, latitude: number, longitude: number, accuracy: number): Promise<Result> {
  try {
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new Error("Invalid location.");
    const user = await requireAppUser("scout");
    const mission = await getMission(id);
    if (mission.scoutId !== user.id || !mission.locationSharingActive || !activeStatuses.includes(mission.status)) throw new Error("Location sharing is not active.");
    await requireActiveBundleLeg(mission);
    const now = new Date();
    const normalizedAccuracy = Math.max(0, Math.min(10000, Math.round(accuracy || 0)));
    const verifiedOnsite = mission.type === "meet" && mission.status === "onsite" && mission.pickupLatitude && mission.pickupLongitude && normalizedAccuracy <= 200 && geographicDistanceMeters(latitude, longitude, Number(mission.pickupLatitude), Number(mission.pickupLongitude)) <= 250;
    const [updated] = await getDb().update(missions).set({
      scoutLatitude: latitude.toFixed(6),
      scoutLongitude: longitude.toFixed(6),
      scoutLocationAccuracyMeters: normalizedAccuracy,
      scoutLocationUpdatedAt: now,
      billableLastVerifiedAt: verifiedOnsite ? now : mission.billableLastVerifiedAt,
      updatedAt: now,
    }).where(and(
      eq(missions.id, id),
      eq(missions.scoutId, user.id),
      eq(missions.status, mission.status),
      eq(missions.locationSharingActive, true),
      isNull(missions.archivedAt),
    )).returning({ id: missions.id });
    if (!updated) throw new Error("Location sharing stopped or the mission changed. Refresh before continuing.");
    revalidatePath(`/dashboard/missions/${id}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to share location." };
  }
}

export async function approveMeetExtension(id: string): Promise<Result> {
  try {
    const user = await requireAppUser("customer");
    const mission = await getMission(id);
    if (mission.customerId !== user.id || mission.type !== "meet" || mission.status !== "onsite") throw new Error("This appointment cannot be extended right now.");
    if (mission.billableEndedAt) throw new Error("The verified appointment time is already finalized and cannot be extended.");
    await requireActiveBundleLeg(mission);
    if (mission.meetAuthorizedMinutes >= 480) throw new Error("The maximum appointment authorization is eight hours.");
    const authorizedMinutes = mission.meetAuthorizedMinutes + 60;
    const maximum = meetPriceForMinutes(authorizedMinutes);
    const acceptedChanges = await acceptedChangeOrderTotals(id);
    const reportCustomerCents = mission.enhancedReportRequested ? enhancedReportCustomerCents : 0;
    const reportScoutCents = mission.enhancedReportRequested ? enhancedReportScoutCents : 0;
    const db = getDb();
    const [updated] = await db.update(missions).set({
      meetAuthorizedMinutes: authorizedMinutes,
      maximumCustomerPriceCents: maximum.customer + reportCustomerCents + acceptedChanges.customerCents - mission.bundleDiscountCents,
      maximumScoutPayoutCents: maximum.scout + reportScoutCents + acceptedChanges.scoutCents,
      updatedAt: new Date(),
    }).where(and(
      eq(missions.id, id),
      eq(missions.customerId, user.id),
      eq(missions.status, "onsite"),
      isNull(missions.billableEndedAt),
      eq(missions.meetAuthorizedMinutes, mission.meetAuthorizedMinutes),
      sql`${missions.maximumCustomerPriceCents} IS NOT DISTINCT FROM ${mission.maximumCustomerPriceCents}`,
      sql`${missions.maximumScoutPayoutCents} IS NOT DISTINCT FROM ${mission.maximumScoutPayoutCents}`,
      isNull(missions.archivedAt),
    )).returning({ id: missions.id });
    if (!updated) throw new Error("The appointment authorization changed in another window. Refresh before trying again.");
    if (mission.scoutId) await notifyUser({ recipientUserId: mission.scoutId, missionId: id, kind: "appointment_extended", title: "Customer approved more appointment time", body: `The verified appointment limit is now ${authorizedMinutes / 60} hours.`, actionLabel: "View appointment", actionUrl: `https://sendascout.com/dashboard/missions/${id}` });
    refreshMission(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to extend this appointment." };
  }
}

export async function requestMissionChangeOrder(id: string, description: string): Promise<Result> {
  try {
    const user = await requireAppUser("customer");
    const mission = await getMission(id);
    const participant = mission.customerId === user.id || mission.scoutId === user.id;
    if (!participant || !mission.scoutId) throw new Error("Only the customer or assigned Scout can request an additional task.");
    await requireActiveBundleLeg(mission);
    if (!["claimed", "en_route", "onsite", "en_route_pickup", "at_pickup", "en_route_dropoff", "at_dropoff"].includes(mission.status)) {
      throw new Error("Additional tasks can be requested only while a mission is active.");
    }
    const cleanDescription = description.trim();
    if (cleanDescription.length < 10 || cleanDescription.length > 1000) throw new Error("Describe the additional task in 10 to 1,000 characters.");
    const now = new Date();
    await getDb().update(missionChangeOrders).set({ status: "expired", updatedAt: now }).where(and(
      eq(missionChangeOrders.missionId, id),
      eq(missionChangeOrders.status, "pending"),
      isNull(missionChangeOrders.approvedByUserId),
      sql`${missionChangeOrders.expiresAt} IS NOT NULL AND ${missionChangeOrders.expiresAt} <= ${now}`,
    ));
    const [existing] = await getDb().select({ id: missionChangeOrders.id }).from(missionChangeOrders).where(and(
      eq(missionChangeOrders.missionId, id),
      eq(missionChangeOrders.status, "pending"),
    )).limit(1);
    if (existing) throw new Error("This mission already has an additional task awaiting approval.");
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
    const createdResult = await getDb().execute<{ id: string }>(sql`
      WITH locked_mission AS MATERIALIZED (
        SELECT active_mission.id, active_mission.bundle_id, active_mission.bundle_sequence
        FROM missions AS active_mission
        WHERE active_mission.id = ${id}
          AND active_mission.archived_at IS NULL
          AND active_mission.scout_id IS NOT NULL
          AND active_mission.status IN ('claimed', 'en_route', 'onsite', 'en_route_pickup', 'at_pickup', 'en_route_dropoff', 'at_dropoff')
          AND (${user.id} = active_mission.customer_id OR ${user.id} = active_mission.scout_id)
        FOR UPDATE OF active_mission
      ), locked_bundle AS MATERIALIZED (
        SELECT active_bundle.id
        FROM mission_bundles AS active_bundle
        INNER JOIN locked_mission ON locked_mission.bundle_id = active_bundle.id
        WHERE active_bundle.active_sequence = locked_mission.bundle_sequence
          AND active_bundle.status IN ('claimed', 'in_progress')
        FOR UPDATE OF active_bundle
      ), eligible_mission AS (
        SELECT locked_mission.id
        FROM locked_mission
        WHERE locked_mission.bundle_id IS NULL OR EXISTS (SELECT 1 FROM locked_bundle)
      ), created_order AS (
        INSERT INTO mission_change_orders (
          mission_id, proposed_by_user_id, kind, status, description,
          customer_delta_cents, scout_delta_cents, platform_delta_cents,
          expires_at, created_at, updated_at
        )
        SELECT eligible_mission.id, ${user.id}, 'additional_task', 'pending', ${cleanDescription},
          ${changeOrderCustomerCents}, ${changeOrderScoutCents}, ${changeOrderCustomerCents - changeOrderScoutCents},
          ${expiresAt}, ${now}, ${now}
        FROM eligible_mission
        ON CONFLICT DO NOTHING
        RETURNING id
      )
      SELECT id::text FROM created_order
    `);
    const orderId = createdResult.rows[0]?.id;
    if (!orderId) throw new Error("The mission changed or already has an additional task awaiting approval. Refresh before trying again.");
    const recipientUserId = user.id === mission.customerId ? mission.scoutId : mission.customerId;
    await notifyUser({
      recipientUserId,
      missionId: id,
      kind: "change_order_requested",
      title: "Additional mission task requested",
      body: user.id === mission.customerId
        ? `The customer authorized a $${(changeOrderCustomerCents / 100).toFixed(0)} task that adds $${(changeOrderScoutCents / 100).toFixed(0)} to your payout. Review and accept it before doing the work.`
        : `Your Scout proposed an additional task for $${(changeOrderCustomerCents / 100).toFixed(0)}. Review and approve the exact charge before work begins.`,
      actionLabel: "Review request",
      actionUrl: `https://sendascout.com/dashboard/missions/${id}`,
    });
    await getDb().insert(missionUpdates).values({ missionId: id, authorId: user.id, status: mission.status, message: `Additional task request ${orderId} created; work is not authorized until the other participant accepts.` });
    refreshMission(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to request the additional task." };
  }
}

export async function respondMissionChangeOrder(id: string, orderId: string, accept: boolean): Promise<Result> {
  try {
    const user = await requireAppUser("customer");
    const mission = await getMission(id);
    const participant = mission.customerId === user.id || mission.scoutId === user.id;
    if (!participant || !mission.scoutId) throw new Error("Only mission participants can respond to this request.");
    await requireActiveBundleLeg(mission);
    if (!["claimed", "en_route", "onsite", "en_route_pickup", "at_pickup", "en_route_dropoff", "at_dropoff"].includes(mission.status)) {
      throw new Error("Additional tasks can be approved or declined only while a mission is active.");
    }
    const [order] = await getDb().select().from(missionChangeOrders).where(and(
      eq(missionChangeOrders.id, orderId),
      eq(missionChangeOrders.missionId, id),
    )).limit(1);
    if (!order || order.status !== "pending") throw new Error("This additional task request is no longer pending.");
    if (order.approvedByUserId && !accept) throw new Error("Both participants already accepted this task. Its payment is still pending.");
    if (order.proposedByUserId === user.id) throw new Error("The other mission participant must respond to this request.");
    const now = new Date();
    if (order.expiresAt && order.expiresAt.getTime() <= now.getTime()) {
      await getDb().update(missionChangeOrders).set({ status: "expired", updatedAt: now }).where(and(
        eq(missionChangeOrders.id, orderId),
        eq(missionChangeOrders.missionId, id),
        eq(missionChangeOrders.status, "pending"),
        isNull(missionChangeOrders.approvedByUserId),
        sql`${missionChangeOrders.expiresAt} IS NOT NULL AND ${missionChangeOrders.expiresAt} <= ${now}`,
      ));
      refreshMission(id);
      throw new Error("This additional task request expired. You can create a new request.");
    }
    if (!accept) {
      const [declined] = await getDb().update(missionChangeOrders).set({ status: "declined", declinedAt: now, updatedAt: now }).where(and(
        eq(missionChangeOrders.id, orderId),
        eq(missionChangeOrders.status, "pending"),
        isNull(missionChangeOrders.approvedByUserId),
        sql`EXISTS (
          SELECT 1 FROM missions AS active_mission
          WHERE active_mission.id = ${id}
            AND active_mission.archived_at IS NULL
            AND active_mission.status IN ('claimed', 'en_route', 'onsite', 'en_route_pickup', 'at_pickup', 'en_route_dropoff', 'at_dropoff')
            AND (${user.id} = active_mission.customer_id OR ${user.id} = active_mission.scout_id)
        )`,
      )).returning({ id: missionChangeOrders.id });
      if (!declined) throw new Error("The request changed in another window. Refresh before trying again.");
      await notifyUser({ recipientUserId: order.proposedByUserId, missionId: id, kind: "change_order_declined", title: "Additional task declined", body: "The additional task was not approved. Continue only with the original mission instructions.", actionLabel: "View mission", actionUrl: `https://sendascout.com/dashboard/missions/${id}` });
    } else {
      if (!order.approvedByUserId) {
        const [accepted] = await getDb().update(missionChangeOrders).set({
          approvedByUserId: user.id,
          approvedAt: now,
          expiresAt: null,
          updatedAt: now,
        }).where(and(
          eq(missionChangeOrders.id, orderId),
          eq(missionChangeOrders.missionId, id),
          eq(missionChangeOrders.status, "pending"),
          isNull(missionChangeOrders.approvedByUserId),
          ne(missionChangeOrders.proposedByUserId, user.id),
          sql`${missionChangeOrders.expiresAt} IS NULL OR ${missionChangeOrders.expiresAt} > ${now}`,
          sql`EXISTS (
            SELECT 1 FROM missions AS active_mission
            WHERE active_mission.id = ${id}
              AND active_mission.archived_at IS NULL
              AND active_mission.status IN ('claimed', 'en_route', 'onsite', 'en_route_pickup', 'at_pickup', 'en_route_dropoff', 'at_dropoff')
              AND (${user.id} = active_mission.customer_id OR ${user.id} = active_mission.scout_id)
              AND (
                active_mission.bundle_id IS NULL
                OR EXISTS (
                  SELECT 1 FROM mission_bundles AS active_bundle
                  WHERE active_bundle.id = active_mission.bundle_id
                    AND active_bundle.active_sequence = active_mission.bundle_sequence
                    AND active_bundle.status IN ('claimed', 'in_progress')
                )
              )
          )`,
        )).returning({ id: missionChangeOrders.id });
        if (!accepted) throw new Error("The mission or request changed in another window. Refresh before trying again.");
      }

      const payment = await ensureAddonPayment({
        kind: "change_order",
        missionId: id,
        customerId: mission.customerId,
        missionChangeOrderId: order.id,
        amountCents: order.customerDeltaCents,
        scoutPayoutCents: order.scoutDeltaCents,
      });
      const paymentAttempt = await attemptSavedPayment(payment.id);
      if (paymentAttempt.state !== "paid") {
        await notifyUser({
          recipientUserId: mission.customerId,
          missionId: id,
          kind: "change_order_payment_required",
          title: "Payment confirmation required",
          body: "Both participants accepted the additional task. Confirm its payment before any extra work begins.",
          actionLabel: "Open payments",
          actionUrl: "https://sendascout.com/dashboard/customer/payments",
        });
      }
    }
    await getDb().insert(missionUpdates).values({ missionId: id, authorId: user.id, status: mission.status, message: accept ? "Both participants accepted the exact price. Additional work is authorized only after customer payment clears." : "The additional task request was declined." });
    refreshMission(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to respond to the additional task." };
  }
}

export async function sendMissionMessage(id: string, body: string): Promise<Result> {
  try {
    const user = await requireAppUser("customer");
    const mission = await getMission(id);
    const participant = user.role === "admin" || mission.customerId === user.id || mission.scoutId === user.id;
    if (!participant || !mission.scoutId) throw new Error("Messaging opens after a Scout accepts the mission.");
    const cleanBody = body.trim();
    if (!cleanBody) throw new Error("Write a message first.");
    if (cleanBody.length > 1500) throw new Error("Messages are limited to 1,500 characters.");
    await getDb().insert(missionMessages).values({ missionId: id, senderId: user.id, body: cleanBody });
    const recipientUserId = user.id === mission.customerId ? mission.scoutId : mission.customerId;
    await notifyUser({ recipientUserId, missionId: id, kind: "new_message", title: "New mission message", body: "You received a private message in Send a Scout. Open the mission to reply without sharing phone numbers.", actionLabel: "Read message", actionUrl: `https://sendascout.com/dashboard/missions/${id}` });
    refreshMission(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to send the message." };
  }
}

export async function confirmMissionComplete(id: string, rating: number, review: string, tipCents: number): Promise<Result> {
  try {
    const user = await requireAppUser("customer");
    const mission = await getMission(id);
    if (mission.customerId !== user.id || mission.status !== "submitted") throw new Error("This mission is not ready for confirmation.");
    if (!mission.scoutId) throw new Error("This mission does not have an assigned Scout.");
    const bundleContext = await requireActiveBundleLeg(mission);
    if (bundleContext) {
      const finalSequence = bundleContext.legs.at(-1)?.bundleSequence;
      if (mission.bundleSequence !== finalSequence || bundleContext.bundle.status !== "submitted") {
        throw new Error("All mission parts must be completed before the booking can be confirmed.");
      }
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error("Choose a rating from 1 to 5 stars.");
    const cleanReview = review.trim();
    if (cleanReview.length > 1500) throw new Error("Reviews are limited to 1,500 characters.");
    if (![0, 300, 500, 1000].includes(tipCents)) throw new Error("Choose one of the available tip amounts.");
    const db = getDb();
    const now = new Date();
    let completion: { id: string; review_id: string; tip_payment_id: string | null } | undefined;
    try {
      const completedResult = await db.execute<{ id: string; review_id: string; tip_payment_id: string | null }>(sql`
      WITH completed_mission AS (
        UPDATE missions AS target
        SET status = 'completed', completed_at = ${now}, location_sharing_active = false,
            scout_latitude = NULL, scout_longitude = NULL, scout_location_accuracy_meters = NULL,
            scout_location_updated_at = NULL, updated_at = ${now}
        WHERE target.id = ${id}
          AND target.customer_id = ${user.id}
          AND target.scout_id = ${mission.scoutId}
          AND target.status = 'submitted'
          AND target.archived_at IS NULL
          AND (
            target.bundle_id IS NULL
            OR EXISTS (
              SELECT 1 FROM mission_bundles AS bundle
              WHERE bundle.id = target.bundle_id
                AND bundle.status = 'submitted'
                AND bundle.active_sequence = target.bundle_sequence
            )
          )
        RETURNING target.id, target.customer_id, target.scout_id, target.bundle_id, target.bundle_sequence
      ), completed_bundle AS (
        UPDATE mission_bundles AS bundle
        SET status = 'completed', completed_at = ${now}, updated_at = ${now}
        FROM completed_mission
        WHERE completed_mission.bundle_id IS NOT NULL
          AND bundle.id = completed_mission.bundle_id
          AND bundle.status = 'submitted'
          AND bundle.active_sequence = completed_mission.bundle_sequence
        RETURNING bundle.id
      ), accepted_result AS (
        UPDATE mission_part_results AS result
        SET status = 'accepted', accepted_at = ${now}, updated_at = ${now}
        FROM completed_mission
        WHERE result.mission_id = completed_mission.id
          AND result.status = 'submitted'
        RETURNING result.id
      ), saved_review AS (
        INSERT INTO mission_reviews (mission_id, customer_id, scout_id, rating, review, tip_cents, tip_status)
        SELECT completed_mission.id, completed_mission.customer_id, completed_mission.scout_id, ${rating}, ${cleanReview || null}, ${tipCents},
          CASE WHEN ${tipCents} > 0 THEN 'pending'::payment_status ELSE 'unpaid'::payment_status END
        FROM completed_mission
        RETURNING id, mission_id, customer_id, scout_id
      ), saved_tip_payment AS (
        INSERT INTO payments (
          mission_id, bundle_id, customer_id, mission_review_id, kind, currency,
          stripe_customer_id, livemode, stripe_transfer_group, idempotency_key,
          amount_cents, scout_payout_cents, platform_fee_cents, status, created_at, updated_at
        )
        SELECT saved_review.mission_id, NULL, saved_review.customer_id, saved_review.id, 'tip', booking.currency,
          booking.stripe_customer_id, booking.livemode, booking.stripe_transfer_group,
          'tip:' || saved_review.id::text || ':v1', ${tipCents}, ${tipCents}, 0, 'pending', ${now}, ${now}
        FROM saved_review
        INNER JOIN completed_mission ON completed_mission.id = saved_review.mission_id
        INNER JOIN payments AS booking ON booking.kind = 'booking'
          AND booking.status = 'paid'
          AND booking.customer_id = saved_review.customer_id
          AND booking.stripe_customer_id IS NOT NULL
          AND booking.stripe_payment_intent_id IS NOT NULL
          AND booking.livemode = ${getStripeLivemode()}
          AND booking.currency = 'usd'
          AND (
            (completed_mission.bundle_id IS NULL AND booking.mission_id = completed_mission.id)
            OR (completed_mission.bundle_id IS NOT NULL AND booking.bundle_id = completed_mission.bundle_id)
          )
        WHERE ${tipCents} > 0
        ON CONFLICT DO NOTHING
        RETURNING id
      ), updated_scout AS (
        UPDATE scout_profiles AS profile
        SET completed_missions = profile.completed_missions + 1,
            rating = ROUND(((COALESCE(profile.rating, 0) * profile.rating_count) + ${rating}) / (profile.rating_count + 1), 2),
            rating_count = profile.rating_count + 1,
            updated_at = ${now}
        FROM saved_review
        WHERE profile.user_id = saved_review.scout_id
        RETURNING profile.user_id
      ), saved_update AS (
        INSERT INTO mission_updates (mission_id, author_id, status, message)
        SELECT completed_mission.id, ${user.id}, 'completed', 'Customer confirmed completion.'
        FROM completed_mission
        WHERE EXISTS (SELECT 1 FROM updated_scout)
        RETURNING mission_id AS id
      )
      SELECT CASE
        WHEN (SELECT COUNT(*) FROM saved_update) = 1
          AND (SELECT COUNT(*) FROM accepted_result) = 1
          AND (SELECT COUNT(*) FROM saved_review) = 1
          AND (SELECT COUNT(*) FROM updated_scout) = 1
          AND (SELECT COUNT(*) FROM saved_tip_payment) = ${tipCents > 0 ? 1 : 0}
          AND (
            (SELECT bundle_id FROM completed_mission) IS NULL
            OR (SELECT COUNT(*) FROM completed_bundle) = 1
          )
        THEN (SELECT id::text FROM saved_update)
        ELSE (1 / ((SELECT COUNT(*)::integer FROM saved_update) - (SELECT COUNT(*)::integer FROM saved_update)))::text
      END AS id,
      (SELECT id::text FROM saved_review) AS review_id,
      (SELECT id::text FROM saved_tip_payment) AS tip_payment_id
      `);
      completion = completedResult.rows[0];
    } catch (error) {
      const code = databaseErrorCode(error);
      console.error("Mission confirmation persistence failed", {
        missionId: id,
        customerId: user.id,
        databaseCode: code ?? "unknown",
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      if (code === "22012") {
        throw new Error("The mission changed in another window. Refresh before trying again.");
      }
      throw new Error("We couldn't confirm this mission. Please try again. If this continues, contact support.");
    }
    if (!completion?.id) throw new Error("The mission changed in another window. Refresh before trying again.");
    try {
      await notifyUser({ recipientUserId: mission.scoutId, missionId: id, kind: "mission_confirmed", title: "Mission confirmed", body: `The customer confirmed completion and left a ${rating}-star rating.${tipCents ? " A tip was requested and will appear in earnings after its payment clears." : ""}`, actionLabel: "View earnings", actionUrl: "https://sendascout.com/dashboard/scout/earnings" });
    } catch (error) {
      console.error("Mission confirmation notification could not be queued", { missionId: id, scoutId: mission.scoutId, error });
    }
    await settleMissionBestEffort(id, "customer_confirmation");
    if (tipCents > 0) {
      try {
        const tipPayment = completion.tip_payment_id
          ? (await db.select().from(payments).where(eq(payments.id, completion.tip_payment_id)).limit(1))[0]
          : await ensureAddonPayment({
            kind: "tip",
            missionId: id,
            customerId: mission.customerId,
            missionReviewId: completion.review_id,
            amountCents: tipCents,
            scoutPayoutCents: tipCents,
          });
        if (tipPayment) {
          const tipAttempt = await attemptSavedPayment(tipPayment.id);
          if (tipAttempt.state !== "paid") {
            await notifyUser({
              recipientUserId: mission.customerId,
              missionId: id,
              kind: "tip_payment_required",
              title: "Tip payment confirmation required",
              body: "Your mission is complete. Confirm the optional tip separately from the Payments page.",
              actionLabel: "Open payments",
              actionUrl: "https://sendascout.com/dashboard/customer/payments",
            });
          }
        }
      } catch (error) {
        console.error("Optional tip payment could not be started", { missionId: id, error });
      }
    }
    refreshMission(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to complete the mission." };
  }
}

export async function setPreferredScoutFromMission(id: string, preferred: boolean): Promise<Result> {
  try {
    const user = await requireAppUser("customer");
    const mission = await getMission(id);
    if (mission.customerId !== user.id || !mission.scoutId) throw new Error("This mission does not have a Scout you can save.");
    const bundleContext = await getBundleContext(mission);
    const bookingCompleted = bundleContext ? bundleContext.bundle.status === "completed" : mission.status === "completed";
    if (!bookingCompleted) throw new Error("You can save a preferred Scout after the mission is completed.");
    if (preferred) {
      await getDb().insert(customerPreferredScouts).values({
        customerId: user.id,
        scoutId: mission.scoutId,
        sourceMissionId: id,
      }).onConflictDoUpdate({
        target: [customerPreferredScouts.customerId, customerPreferredScouts.scoutId],
        set: { sourceMissionId: id },
      });
    } else {
      await getDb().delete(customerPreferredScouts).where(and(
        eq(customerPreferredScouts.customerId, user.id),
        eq(customerPreferredScouts.scoutId, mission.scoutId),
      ));
    }
    revalidatePath(`/dashboard/missions/${id}`);
    revalidatePath("/dashboard/customer/saved");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to update your preferred Scout." };
  }
}

export async function adminSetScoutStatus(profileId: string, status: "review" | "approved" | "paused" | "rejected"): Promise<Result> {
  try {
    await requireAdminUser();
    const [existing] = await getDb().select({
      identityCheck: scoutProfiles.identityCheck,
      identityProvider: scoutProfiles.identityProvider,
      identityVerificationReference: scoutProfiles.identityVerificationReference,
      identityVerifiedName: scoutProfiles.identityVerifiedName,
      identityVerifiedAt: scoutProfiles.identityVerifiedAt,
      identityVerifiedBy: scoutProfiles.identityVerifiedBy,
      headshotPath: scoutProfiles.headshotPath,
      homeZip: scoutProfiles.homeZip,
      serviceRadiusMiles: scoutProfiles.serviceRadiusMiles,
      vehicleType: scoutProfiles.vehicleType,
      canSee: scoutProfiles.canSee,
      canMove: scoutProfiles.canMove,
      canMeet: scoutProfiles.canMeet,
      verificationConsentedAt: scoutProfiles.verificationConsentedAt,
      handbookVersion: scoutProfiles.handbookVersion,
      handbookAcceptedAt: scoutProfiles.handbookAcceptedAt,
      stripeAccountId: scoutProfiles.stripeAccountId,
      stripeAccountApiVersion: scoutProfiles.stripeAccountApiVersion,
      stripeAccountLivemode: scoutProfiles.stripeAccountLivemode,
      stripeConnectStatus: scoutProfiles.stripeConnectStatus,
      stripeDetailsSubmitted: scoutProfiles.stripeDetailsSubmitted,
      stripeTransfersActive: scoutProfiles.stripeTransfersActive,
      payoutsEnabled: scoutProfiles.payoutsEnabled,
      stripeRequirementsCurrentlyDue: scoutProfiles.stripeRequirementsCurrentlyDue,
      stripeRequirementsPastDue: scoutProfiles.stripeRequirementsPastDue,
      stripeRequirementsPendingVerification: scoutProfiles.stripeRequirementsPendingVerification,
      stripeOnboardingCompletedAt: scoutProfiles.stripeOnboardingCompletedAt,
      stripePayoutScheduleConfiguredAt: scoutProfiles.stripePayoutScheduleConfiguredAt,
      stripeSyncGeneration: scoutProfiles.stripeSyncGeneration,
      stripeSyncCompletedGeneration: scoutProfiles.stripeSyncCompletedGeneration,
      firstName: users.firstName,
      lastName: users.lastName,
      phone: users.phone,
      legalVersion: users.legalVersion,
      legalAcceptedAt: users.legalAcceptedAt,
      profileStatus: scoutProfiles.status,
    }).from(scoutProfiles).innerJoin(users, eq(users.id, scoutProfiles.userId)).where(eq(scoutProfiles.id, profileId)).limit(1);
    if (!existing) throw new Error("Scout profile not found.");
    if (status === "approved") {
      if (existing.profileStatus !== "paused") throw new Error("Only a paused Scout can be restored manually. New applicants approve automatically when every requirement is complete.");
      const missing = scoutApprovalChecklist(existing, LEGAL_VERSION, getStripeLivemode()).filter((item) => !item.complete);
      if (missing.length) throw new Error(`Complete the approval checklist first: ${missing.map((item) => item.label).join(", ")}.`);
    }
    const now = new Date();
    const [profile] = status === "approved"
      ? await getDb().update(scoutProfiles).set({
        status: "approved",
        approvedAt: now,
        updatedAt: now,
      }).where(and(
        eq(scoutProfiles.id, profileId),
        ...scoutProfileClaimReadinessConditions(getStripeLivemode(), ["paused"]),
        sql`EXISTS (
          SELECT 1
          FROM ${users} AS restore_user
          WHERE restore_user.id = ${scoutProfiles.userId}
            AND restore_user.role = 'scout'
            AND restore_user.status = 'active'
            AND restore_user.legal_version = ${LEGAL_VERSION}
            AND restore_user.legal_accepted_at IS NOT NULL
            AND btrim(COALESCE(restore_user.first_name, '')) <> ''
            AND btrim(COALESCE(restore_user.last_name, '')) <> ''
            AND length(regexp_replace(COALESCE(restore_user.phone, ''), '\\D', '', 'g')) >= 10
        )`,
      )).returning({ userId: scoutProfiles.userId })
      : await getDb().update(scoutProfiles).set({
        status,
        approvedAt: null,
        updatedAt: now,
      }).where(eq(scoutProfiles.id, profileId)).returning({ userId: scoutProfiles.userId });
    if (status === "approved" && !profile) throw new Error("The Scout’s readiness changed before access could be restored. Refresh Stripe and the checklist, then try again.");
    if (profile && status === "approved") {
      const approvalNotice = await ensureScoutApprovalNotification(profile.userId);
      if (!approvalNotice.created && !approvalNotice.emailQueued) {
        await notifyUser({ recipientUserId: profile.userId, kind: "scout_access_restored", title: "Your Scout access is restored", body: "You can once again review and claim missions within your selected service area.", actionLabel: "Browse missions", actionUrl: "https://sendascout.com/dashboard/scout/missions" });
      }
      try {
        await alertScoutToOpenMissions(profile.userId);
      } catch (alertError) {
        console.warn("Scout approved, but existing mission alerts could not be backfilled", alertError);
      }
    }
    revalidatePath("/dashboard/scout");
    revalidatePath("/dashboard/scout/missions");
    revalidatePath("/control-room");
    revalidatePath("/control-room/scouts");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to update the Scout." };
  }
}

export async function adminSetMissionStatus(id: string, status: "draft" | "open" | "cancelled" | "completed"): Promise<Result> {
  try {
    const admin = await requireAdminUser();
    const mission = await getMission(id);
    const db = getDb();
    const bundleContext = await getBundleContext(mission);
    const rootMission = bundleContext?.legs[0] ?? mission;
    const now = new Date();
    if (status === "open" && (rootMission.paymentStatus !== "paid" || (bundleContext && bundleContext.bundle.paymentStatus !== "paid"))) {
      throw new Error("Only bookings with confirmed customer payment can be opened to Scouts.");
    }
    if (mission.status === "disputed" || bundleContext?.bundle.status === "disputed") {
      throw new Error("Resolve the open mission case instead of using a direct status override.");
    }
    const effectivePaymentStatus = bundleContext?.bundle.paymentStatus ?? mission.paymentStatus;
    if (status === "cancelled" && ["authorized", "paid", "partially_refunded", "refunded", "disputed"].includes(effectivePaymentStatus)) {
      throw new Error("Paid bookings must be cancelled through a mission case so the customer refund and Scout payout decisions are recorded together.");
    }
    const [openCase] = await db.select({ id: missionCases.id }).from(missionCases)
      .innerJoin(missions, eq(missions.id, missionCases.missionId))
      .where(and(
        eq(missionCases.status, "open"),
        bundleContext ? eq(missions.bundleId, bundleContext.bundle.id) : eq(missions.id, mission.id),
      )).limit(1);
    if (openCase) throw new Error("Resolve the open mission case before changing this booking directly.");

    if (status === "open" || status === "draft") {
      const expectedStatus = status === "open" ? "draft" : "open";
      if (bundleContext) {
        if (bundleContext.bundle.activeSequence !== 1 || rootMission.status !== expectedStatus || bundleContext.bundle.status !== expectedStatus) {
          throw new Error(status === "open" ? "Only a pulled bundle can be reopened." : "Only an unclaimed open bundle can be pulled from Scouts.");
        }
        if (bundleContext.legs.some((leg) => leg.scoutId || (leg.id !== rootMission.id && leg.status !== "draft"))) {
          throw new Error("A bundle can be pulled or reopened only before a Scout claims it.");
        }
      } else if (mission.status !== expectedStatus || (status === "draft" && mission.scoutId)) {
        throw new Error(status === "open" ? "Only draft missions can be opened." : "Only unclaimed open missions can be pulled from Scouts.");
      }

      const verifiedQuote = status === "open" ? await calculateMissionQuote({
        type: rootMission.type,
        address: rootMission.addressLine1,
        addressLine2: rootMission.addressLine2 ?? "",
        city: rootMission.city,
        state: rootMission.state,
        zip: rootMission.zip,
        pickupAddress: rootMission.addressLine1,
        pickupAddressLine2: rootMission.addressLine2 ?? "",
        pickupCity: rootMission.city,
        pickupState: rootMission.state,
        pickupZip: rootMission.zip,
        dropoffAddress: rootMission.dropoffAddressLine1 ?? "",
        dropoffAddressLine2: rootMission.dropoffAddressLine2 ?? "",
        dropoffCity: rootMission.dropoffCity ?? "",
        dropoffState: rootMission.dropoffState ?? "",
        dropoffZip: rootMission.dropoffZip ?? "",
        largeItem: rootMission.largeItem,
        meetAuthorizedMinutes: rootMission.meetAuthorizedMinutes,
      }) : null;
      if (status === "open" && rootMission.type === "move" && verifiedQuote?.routeSource !== "google") throw new Error("Connect Google route verification before releasing Move It missions.");
      if (status === "open" && rootMission.type === "meet" && !verifiedQuote?.pickupCoordinates) throw new Error("Connect Google address verification before releasing Meet It missions.");

      const acceptedChanges = verifiedQuote ? await acceptedChangeOrderTotals(rootMission.id) : { customerCents: 0, scoutCents: 0, platformCents: 0 };
      const reportCustomerCents = rootMission.enhancedReportRequested ? enhancedReportCustomerCents : 0;
      const reportScoutCents = rootMission.enhancedReportRequested ? enhancedReportScoutCents : 0;
      const listCustomerPriceCents = verifiedQuote ? verifiedQuote.customerPriceCents + reportCustomerCents + acceptedChanges.customerCents : rootMission.listCustomerPriceCents;
      const customerPriceCents = verifiedQuote && listCustomerPriceCents !== null
        ? listCustomerPriceCents - rootMission.bundleDiscountCents
        : rootMission.customerPriceCents;
      const scoutPayoutCents = verifiedQuote ? verifiedQuote.scoutPayoutCents + reportScoutCents + acceptedChanges.scoutCents : rootMission.scoutPayoutCents;
      const platformFeeCents = customerPriceCents - scoutPayoutCents;
      if (verifiedQuote && platformFeeCents < 0) throw new Error("The verified route price cannot cover the approved Scout payout. Review this mission before release.");
      const rootChanges: Partial<typeof missions.$inferInsert> = {
        status,
        ...(verifiedQuote ? {
          customerPriceCents,
          listCustomerPriceCents,
          scoutPayoutCents,
          platformFeeCents,
          maximumCustomerPriceCents: verifiedQuote.maximumCustomerPriceCents + reportCustomerCents + acceptedChanges.customerCents - rootMission.bundleDiscountCents,
          maximumScoutPayoutCents: verifiedQuote.maximumScoutPayoutCents + reportScoutCents + acceptedChanges.scoutCents,
          pickupLatitude: verifiedQuote.pickupCoordinates?.latitude.toFixed(6) ?? null,
          pickupLongitude: verifiedQuote.pickupCoordinates?.longitude.toFixed(6) ?? null,
          dropoffLatitude: verifiedQuote.dropoffCoordinates?.latitude.toFixed(6) ?? null,
          dropoffLongitude: verifiedQuote.dropoffCoordinates?.longitude.toFixed(6) ?? null,
          routeDistanceMeters: verifiedQuote.routeDistanceMeters,
          routeDurationSeconds: verifiedQuote.routeDurationSeconds,
          routePolyline: verifiedQuote.routePolyline,
          routeSource: verifiedQuote.routeSource,
          routeQuotedAt: verifiedQuote.routeSource === "google" ? now : null,
        } : {}),
        locationSharingActive: false,
        scoutLatitude: null,
        scoutLongitude: null,
        scoutLocationAccuracyMeters: null,
        scoutLocationUpdatedAt: null,
        updatedAt: now,
      };

      if (bundleContext) {
        const previousList = rootMission.listCustomerPriceCents ?? rootMission.customerPriceCents + rootMission.bundleDiscountCents;
        try {
          await db.execute(sql`
            WITH updated_root AS (
              UPDATE missions AS root
              SET status = ${status}::mission_status,
                  alert_generation = CASE
                    WHEN ${status} = 'open' THEN root.alert_generation + 1
                    ELSE root.alert_generation
                  END,
                  customer_price_cents = ${customerPriceCents},
                  list_customer_price_cents = ${listCustomerPriceCents},
                  scout_payout_cents = ${scoutPayoutCents},
                  platform_fee_cents = ${platformFeeCents},
                  maximum_customer_price_cents = ${verifiedQuote ? verifiedQuote.maximumCustomerPriceCents + reportCustomerCents + acceptedChanges.customerCents - rootMission.bundleDiscountCents : rootMission.maximumCustomerPriceCents},
                  maximum_scout_payout_cents = ${verifiedQuote ? verifiedQuote.maximumScoutPayoutCents + reportScoutCents + acceptedChanges.scoutCents : rootMission.maximumScoutPayoutCents},
                  pickup_latitude = ${verifiedQuote?.pickupCoordinates?.latitude.toFixed(6) ?? rootMission.pickupLatitude},
                  pickup_longitude = ${verifiedQuote?.pickupCoordinates?.longitude.toFixed(6) ?? rootMission.pickupLongitude},
                  dropoff_latitude = ${verifiedQuote?.dropoffCoordinates?.latitude.toFixed(6) ?? rootMission.dropoffLatitude},
                  dropoff_longitude = ${verifiedQuote?.dropoffCoordinates?.longitude.toFixed(6) ?? rootMission.dropoffLongitude},
                  route_distance_meters = ${verifiedQuote?.routeDistanceMeters ?? rootMission.routeDistanceMeters},
                  route_duration_seconds = ${verifiedQuote?.routeDurationSeconds ?? rootMission.routeDurationSeconds},
                  route_polyline = ${verifiedQuote?.routePolyline ?? rootMission.routePolyline},
                  route_source = ${verifiedQuote?.routeSource ?? rootMission.routeSource},
                  route_quoted_at = ${verifiedQuote ? (verifiedQuote.routeSource === "google" ? now : null) : rootMission.routeQuotedAt},
                  location_sharing_active = false,
                  scout_latitude = NULL,
                  scout_longitude = NULL,
                  scout_location_accuracy_meters = NULL,
                  scout_location_updated_at = NULL,
                  updated_at = ${now}
              WHERE root.id = ${rootMission.id}
                AND root.status = ${expectedStatus}
                AND root.scout_id IS NULL
                AND root.archived_at IS NULL
              RETURNING root.id, root.bundle_id
            ), updated_bundle AS (
              UPDATE mission_bundles AS bundle
              SET status = ${status},
                  list_customer_price_cents = ${bundleContext.bundle.listCustomerPriceCents + (Number(listCustomerPriceCents) - previousList)},
                  customer_price_cents = ${bundleContext.bundle.customerPriceCents + (customerPriceCents - rootMission.customerPriceCents)},
                  scout_payout_cents = ${bundleContext.bundle.scoutPayoutCents + (scoutPayoutCents - rootMission.scoutPayoutCents)},
                  platform_fee_cents = ${bundleContext.bundle.platformFeeCents + (platformFeeCents - rootMission.platformFeeCents)},
                  updated_at = ${now}
              FROM updated_root
              WHERE bundle.id = updated_root.bundle_id
                AND bundle.status = ${expectedStatus}
                AND bundle.active_sequence = 1
              RETURNING bundle.id
            )
            SELECT CASE
              WHEN (SELECT COUNT(*) FROM updated_root) = 1
                AND (SELECT COUNT(*) FROM updated_bundle) = 1
              THEN (SELECT id::text FROM updated_bundle)
              ELSE (1 / ((SELECT COUNT(*)::integer FROM updated_bundle) - (SELECT COUNT(*)::integer FROM updated_bundle)))::text
            END AS id
          `);
        } catch {
          throw new Error("The mission bundle changed in another window. Refresh before trying again.");
        }
      } else {
        const [updated] = await db.update(missions).set({
          ...rootChanges,
          ...(status === "open" ? { alertGeneration: sql`${missions.alertGeneration} + 1` } : {}),
        }).where(and(
          eq(missions.id, rootMission.id),
          eq(missions.status, expectedStatus),
          isNull(missions.archivedAt),
        )).returning({ id: missions.id });
        if (!updated) throw new Error("The mission changed in another window. Refresh before trying again.");
      }

      await db.insert(missionUpdates).values({
        missionId: rootMission.id,
        authorId: admin.id,
        status,
        message: status === "draft" ? "Control Room pulled this mission from the Scout board." : "Control Room reopened this mission to Scouts.",
        evidenceKind: status === "open" ? "mission_publication" : null,
      });
      if (status === "draft") await db.update(notifications).set({ readAt: now }).where(and(eq(notifications.missionId, rootMission.id), eq(notifications.kind, "new_mission")));
      if (status === "open") await alertEligibleScouts(rootMission.id);
      refreshMission(rootMission.id);
      return { ok: true };
    }

    if (bundleContext) {
      if (["completed", "cancelled"].includes(bundleContext.bundle.status)) throw new Error("This mission bundle is already closed.");
      const targetLegs = bundleContext.legs.filter((leg) => !["completed", "cancelled"].includes(leg.status));
      const expectedScoutCount = status === "completed" && mission.scoutId ? 1 : 0;
      let updatedBundle: { id: string } | undefined;
      try {
        const updatedBundleResult = await db.execute<{ id: string }>(sql`
          WITH changed AS (
            UPDATE missions AS leg
            SET status = ${status}::mission_status,
                completed_at = CASE WHEN ${status} = 'completed' THEN ${now} ELSE leg.completed_at END,
                location_sharing_active = false,
                scout_latitude = NULL,
                scout_longitude = NULL,
                scout_location_accuracy_meters = NULL,
                scout_location_updated_at = NULL,
                updated_at = ${now}
            WHERE leg.bundle_id = ${bundleContext.bundle.id}
              AND leg.archived_at IS NULL
              AND leg.status NOT IN ('completed', 'cancelled')
            RETURNING leg.id, leg.scout_id
          ), closed_bundle AS (
            UPDATE mission_bundles AS bundle
            SET status = ${status},
                active_sequence = CASE WHEN ${status} = 'completed' THEN ${bundleContext.legs.length} ELSE bundle.active_sequence END,
                completed_at = CASE WHEN ${status} = 'completed' THEN ${now} ELSE bundle.completed_at END,
                updated_at = ${now}
            WHERE bundle.id = ${bundleContext.bundle.id}
              AND bundle.status = ${bundleContext.bundle.status}
            RETURNING bundle.id
          ), updated_scout AS (
            UPDATE scout_profiles AS profile
            SET completed_missions = profile.completed_missions + 1,
                updated_at = ${now}
            FROM (
              SELECT DISTINCT changed.scout_id
              FROM changed
              WHERE changed.scout_id IS NOT NULL
                AND ${status} = 'completed'
                AND EXISTS (SELECT 1 FROM closed_bundle)
            ) AS completed_booking
            WHERE profile.user_id = completed_booking.scout_id
            RETURNING profile.user_id
          )
          SELECT CASE
            WHEN (SELECT COUNT(*) FROM changed) = ${targetLegs.length}
              AND (SELECT COUNT(*) FROM closed_bundle) = 1
              AND (SELECT COUNT(*) FROM updated_scout) = ${expectedScoutCount}
            THEN (SELECT id::text FROM closed_bundle)
            ELSE (1 / ((SELECT COUNT(*)::integer FROM closed_bundle) - (SELECT COUNT(*)::integer FROM closed_bundle)))::text
          END AS id
        `);
        updatedBundle = updatedBundleResult.rows[0];
      } catch {
        throw new Error("The mission bundle changed in another window. Refresh before trying again.");
      }
      if (!updatedBundle?.id) throw new Error("The mission bundle changed in another window. Refresh before trying again.");
      if (targetLegs.length) await db.insert(missionUpdates).values(targetLegs.map((leg) => ({ missionId: leg.id, authorId: admin.id, status, message: `Control Room changed the mission bundle to ${status}.` })));
    } else {
      if (["completed", "cancelled"].includes(mission.status)) throw new Error("This mission is already closed.");
      const expectedScoutCount = status === "completed" && mission.scoutId ? 1 : 0;
      try {
        await db.execute(sql`
          WITH changed AS (
            UPDATE missions AS target
            SET status = ${status}::mission_status,
                completed_at = CASE WHEN ${status} = 'completed' THEN ${now} ELSE target.completed_at END,
                location_sharing_active = FALSE,
                scout_latitude = NULL,
                scout_longitude = NULL,
                scout_location_accuracy_meters = NULL,
                scout_location_updated_at = NULL,
                updated_at = ${now}
            WHERE target.id = ${id}
              AND target.status = ${mission.status}
              AND target.archived_at IS NULL
            RETURNING target.id, target.scout_id
          ), updated_scout AS (
            UPDATE scout_profiles AS profile
            SET completed_missions = profile.completed_missions + 1,
                updated_at = ${now}
            FROM changed
            WHERE profile.user_id = changed.scout_id
              AND ${status} = 'completed'
            RETURNING profile.user_id
          ), audited AS (
            INSERT INTO mission_updates (mission_id, author_id, status, message)
            SELECT changed.id, ${admin.id}, ${status}::mission_status, ${`Control Room changed mission to ${status}.`}
            FROM changed
            RETURNING id
          )
          SELECT CASE
            WHEN (SELECT COUNT(*) FROM changed) = 1
              AND (SELECT COUNT(*) FROM updated_scout) = ${expectedScoutCount}
              AND (SELECT COUNT(*) FROM audited) = 1
            THEN (SELECT id::text FROM changed)
            ELSE (1 / ((SELECT COUNT(*)::integer FROM changed) - (SELECT COUNT(*)::integer FROM changed)))::text
          END AS id
        `);
      } catch {
        throw new Error("The mission changed in another window. Refresh before trying again.");
      }
    }
    if (status === "cancelled") {
      try {
        await cancelUncollectedBookingCheckout(rootMission.id);
      } catch (error) {
        await reportException(error, { route: "missions.admin_cancel_uncollected_booking_checkout", missionId: rootMission.id });
      }
      await notifyUser({ recipientUserId: mission.customerId, missionId: id, kind: "mission_cancelled", title: "Mission cancelled", body: "This mission has been cancelled. Any eligible payment adjustment will follow the cancellation policy.", actionLabel: "View mission", actionUrl: `https://sendascout.com/dashboard/missions/${id}` });
      if (mission.scoutId) await notifyUser({ recipientUserId: mission.scoutId, missionId: id, kind: "mission_cancelled", title: "Mission cancelled", body: "This mission has been cancelled and removed from your active work.", actionLabel: "Open Scout dashboard", actionUrl: "https://sendascout.com/dashboard/scout" });
    }
    if (status === "completed") await settleMissionBestEffort(rootMission.id, "admin_status_override");
    refreshMission(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to update the mission." };
  }
}

export async function markNotificationRead(id: string): Promise<void> {
  const user = await requireAppUser("customer");
  await getDb().update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.id, id), eq(notifications.recipientUserId, user.id)));
  revalidatePath("/dashboard/customer");
  revalidatePath("/dashboard/scout");
  revalidatePath("/dashboard/notifications");
}

export async function markAllNotificationsRead(): Promise<void> {
  const user = await requireAppUser("customer");
  await getDb().update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.recipientUserId, user.id), eq(notifications.channel, "in_app"), isNull(notifications.readAt)));
  revalidatePath("/dashboard/customer");
  revalidatePath("/dashboard/scout");
  revalidatePath("/dashboard/notifications");
}

function statusLabel(type: "see" | "move" | "meet", status: MissionStatus) {
  if (type === "move") {
    const labels: Partial<Record<MissionStatus, string>> = {
      claimed: "Your Scout accepted the delivery.",
      en_route_pickup: "Your Scout is en route to the pickup.",
      at_pickup: "Your Scout is at the pickup location.",
      en_route_dropoff: "Your Scout is on the way to the drop-off.",
      at_dropoff: "Your Scout arrived at the drop-off.",
      submitted: "Your Scout marked the delivery complete.",
    };
    return labels[status] ?? `Mission status: ${status}`;
  }
  const noun = type === "see" ? "inspection" : "appointment";
  const labels: Partial<Record<MissionStatus, string>> = {
    claimed: `Your Scout accepted the ${noun}.`,
    en_route: `Your Scout is en route to the ${noun}.`,
    onsite: type === "meet" ? "Your Scout checked in onsite. Verified appointment time has started." : `Your Scout is at the ${noun} location.`,
    submitted: `Your Scout submitted the ${noun} results.`,
  };
  return labels[status] ?? `Mission status: ${status}`;
}
