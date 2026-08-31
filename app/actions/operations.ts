"use server";

import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  missionBundles,
  missionCases,
  missions,
  missionUpdates,
  notifications,
  operationalEvents,
  paymentDisputes,
  paymentRefunds,
  payments,
} from "@/db/schema";
import { requireAdminUser, requireAppUser } from "@/lib/app-user";
import {
  cancellationMode,
  bundledCancellationMode,
  bundleStatusAfterResolution,
  caseKindAllowed,
  caseLabel,
  caseResolutionIsFinal,
  missionStatusAfterResolution,
  remainingCaseAdjustmentCents,
  type MissionCaseResolution,
  type MissionCaseKind,
  type OperationalMissionStatus,
} from "@/lib/mission-operations";
import { notifyUser, retryNotification } from "@/lib/notifications";
import { reportException } from "@/lib/observability";
import { getMissionRefundCapacity } from "@/lib/stripe-refund-capacity";
import { missionCaseRefundReason, requestMissionRefund } from "@/lib/stripe-refunds";
import { settleCasePayoutBestEffort, settleMissionBestEffort } from "@/lib/stripe-settlement";

type Result = { ok: true } | { ok: false; error: string };
type CaseResolution = MissionCaseResolution;

const TWO_PERSON_REFUND_THRESHOLD_CENTS = 10_000;

function refreshOperations(missionId: string) {
  revalidatePath(`/dashboard/missions/${missionId}`);
  revalidatePath("/dashboard/customer");
  revalidatePath("/dashboard/scout");
  revalidatePath("/control-room");
}

async function reportUnexpectedAtomicFailure(error: unknown, operation: string, context: Record<string, unknown>) {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
  if (code === "22012" || code === "23505") return;
  await reportException(error, { route: `operations.${operation}`, ...context });
}

export async function openMissionCase(missionId: string, kind: MissionCaseKind, summary: string): Promise<Result> {
  try {
    const user = await requireAppUser("customer");
    const db = getDb();
    const [mission] = await db.select().from(missions).where(eq(missions.id, missionId)).limit(1);
    if (!mission) throw new Error("Mission not found.");
    if (mission.archivedAt) throw new Error("Archived missions cannot be changed. Contact support if you need the archived record reviewed.");
    const [bundle] = mission.bundleId
      ? await db.select().from(missionBundles).where(eq(missionBundles.id, mission.bundleId)).limit(1)
      : [null];
    if (bundle && mission.bundleSequence !== bundle.activeSequence) {
      throw new Error(`Open part ${bundle.activeSequence} of this itinerary before submitting a support request.`);
    }
    if (mission.status === "disputed" || bundle?.status === "disputed") {
      throw new Error("This mission already has an open Control Room review.");
    }
    const participantRole = mission.customerId === user.id ? "customer" : mission.scoutId === user.id ? "scout" : user.role === "admin" ? "admin" : null;
    if (!participantRole || !caseKindAllowed(participantRole, kind)) throw new Error("You cannot submit that request for this mission.");

    const cleanSummary = summary.trim();
    if (cleanSummary.length < 10) throw new Error("Add at least a short explanation so the issue can be reviewed.");
    if (cleanSummary.length > 2000) throw new Error("Issue details are limited to 2,000 characters.");
    const [duplicate] = bundle
      ? await db.select({ id: missionCases.id }).from(missionCases)
        .innerJoin(missions, eq(missions.id, missionCases.missionId))
        .where(and(eq(missions.bundleId, bundle.id), eq(missionCases.status, "open"))).limit(1)
      : await db.select({ id: missionCases.id }).from(missionCases)
        .where(and(eq(missionCases.missionId, missionId), eq(missionCases.status, "open"))).limit(1);
    if (duplicate) throw new Error("This mission already has an open Control Room review.");

    const previousStatus = mission.status as OperationalMissionStatus;
    const cancellation = bundle ? bundledCancellationMode(previousStatus, bundle.activeSequence) : cancellationMode(previousStatus);
    const immediateCancellation = kind === "customer_cancellation" && cancellation === "immediate";
    if (kind === "customer_cancellation" && cancellation === "unavailable") {
      throw new Error("This mission can no longer be cancelled. Use Report a problem so Control Room can review it.");
    }
    const now = new Date();
    const customerPriceCents = bundle?.customerPriceCents ?? mission.customerPriceCents;
    const paymentStatus = bundle?.paymentStatus ?? mission.paymentStatus;
    const affectedLegs = bundle
      ? await db.select({ id: missions.id, status: missions.status }).from(missions).where(and(eq(missions.bundleId, bundle.id), isNull(missions.archivedAt)))
      : [{ id: mission.id, status: mission.status }];
    const nextStatus: OperationalMissionStatus = immediateCancellation ? "cancelled" : "disputed";
    const caseId = crypto.randomUUID();
    const refundCapacity = immediateCancellation && ["authorized", "paid", "partially_refunded"].includes(paymentStatus)
      ? await getMissionRefundCapacity(missionId)
      : null;
    // A concurrent cancellation can temporarily consume all refundable capacity
    // before its case exists. Treat that as a conflict, never as permission for a
    // second request to commit a paid cancellation with a zero-dollar refund.
    if (refundCapacity && refundCapacity.unlinkedMissionCaseReservationCents > 0) {
      throw new Error("A cancellation refund is already being reserved. Refresh this mission before trying again.");
    }
    const refundAmountCents = immediateCancellation
      ? Math.min(customerPriceCents, refundCapacity?.refundableCents ?? 0)
      : 0;
    const refundReason = missionCaseRefundReason(caseId);
    const refundIdempotencyKey = `mission-case:${caseId}:refund:v1`;
    let reservedRefundIds: string[] = [];
    if (refundAmountCents > 0) {
      const reservation = await requestMissionRefund({
        missionId,
        amountCents: refundAmountCents,
        idempotencyKey: refundIdempotencyKey,
        reason: refundReason,
        deferProcessing: true,
      });
      if (reservation.refundRequestedCents !== refundAmountCents
        || reservation.refundPendingCents !== refundAmountCents
        || reservation.refunds.some((refund) => refund.missionCaseId !== null || refund.stripeRefundId !== null)) {
        throw new Error("The cancellation refund could not be safely reserved against the original charge.");
      }
      reservedRefundIds = reservation.refunds.map((refund) => refund.id);
    }
    const expectedBundleCount = bundle ? 1 : 0;
    const expectedOtherLegCount = immediateCancellation && bundle ? Math.max(0, affectedLegs.length - 1) : 0;
    const expectedAuditCount = 1 + expectedOtherLegCount;
    const expectedRefundCount = reservedRefundIds.length;
    const reservedRefundPredicate = reservedRefundIds.length
      ? sql`refund.id IN (${sql.join(reservedRefundIds.map((id) => sql`${id}::uuid`), sql`, `)})`
      : sql`FALSE`;
    const competingRefundPredicate = reservedRefundIds.length
      ? sql`competing_refund.id NOT IN (${sql.join(reservedRefundIds.map((id) => sql`${id}::uuid`), sql`, `)})`
      : sql`TRUE`;
    const noCompetingCancellationReservation = refundCapacity
      ? sql`NOT EXISTS (
          SELECT 1
          FROM payment_refunds AS competing_refund
          INNER JOIN payments AS refunded_payment ON refunded_payment.id = competing_refund.payment_id
          WHERE refunded_payment.mission_id IN (${sql.join(refundCapacity.missionIds.map((id) => sql`${id}::uuid`), sql`, `)})
            AND refunded_payment.kind NOT IN ('tip', 'duplicate')
            AND competing_refund.mission_case_id IS NULL
            AND competing_refund.status IN ('pending', 'requires_action')
            AND competing_refund.reason LIKE 'mission-case:%'
            AND ${competingRefundPredicate}
        )`
      : sql`TRUE`;
    const noOpenCase = bundle
      ? sql`NOT EXISTS (
          SELECT 1 FROM mission_cases AS existing_case
          INNER JOIN missions AS case_mission ON case_mission.id = existing_case.mission_id
          WHERE existing_case.status = 'open' AND case_mission.bundle_id = ${bundle.id}
        )`
      : sql`NOT EXISTS (
          SELECT 1 FROM mission_cases AS existing_case
          WHERE existing_case.status = 'open' AND existing_case.mission_id = ${missionId}
        )`;
    const bundleGuard = bundle
      ? sql`EXISTS (
          SELECT 1 FROM mission_bundles AS guarded_bundle
          WHERE guarded_bundle.id = ${bundle.id}
            AND guarded_bundle.status = ${bundle.status}
            AND guarded_bundle.active_sequence = ${bundle.activeSequence}
        )`
      : sql`TRUE`;
    const auditMessage = immediateCancellation
      ? "Customer cancelled the complete itinerary before verified work began."
      : `${caseLabel(kind)}. Control Room review opened${bundle ? " for the itinerary" : ""}.`;
    try {
      await db.execute(sql`
        WITH active_leg AS (
          UPDATE missions AS mission
          SET status = ${nextStatus},
              location_sharing_active = FALSE,
              scout_latitude = NULL,
              scout_longitude = NULL,
              scout_location_accuracy_meters = NULL,
              scout_location_updated_at = NULL,
              updated_at = ${now}
          WHERE mission.id = ${missionId}
            AND mission.status = ${previousStatus}
            AND mission.archived_at IS NULL
            AND ${noOpenCase}
            AND ${bundleGuard}
            AND ${noCompetingCancellationReservation}
          RETURNING mission.id, mission.bundle_id
        ), updated_bundle AS (
          UPDATE mission_bundles AS bundle
          SET status = ${nextStatus}, updated_at = ${now}
          FROM active_leg
          WHERE bundle.id = active_leg.bundle_id
            AND bundle.id = ${bundle?.id ?? null}
            AND bundle.status = ${bundle?.status ?? "draft"}
            AND bundle.active_sequence = ${bundle?.activeSequence ?? 0}
          RETURNING bundle.id
        ), updated_other_legs AS (
          UPDATE missions AS other_leg
          SET status = ${nextStatus},
              location_sharing_active = FALSE,
              scout_latitude = NULL,
              scout_longitude = NULL,
              scout_location_accuracy_meters = NULL,
              scout_location_updated_at = NULL,
              updated_at = ${now}
          WHERE ${immediateCancellation && Boolean(bundle)}
            AND other_leg.bundle_id = ${bundle?.id ?? null}
            AND other_leg.id <> ${missionId}
            AND other_leg.archived_at IS NULL
            AND EXISTS (SELECT 1 FROM active_leg)
            AND (${expectedBundleCount} = 0 OR EXISTS (SELECT 1 FROM updated_bundle))
          RETURNING other_leg.id
        ), created_case AS (
          INSERT INTO mission_cases (
            id, mission_id, reporter_id, kind, status, previous_mission_status, summary,
            resolution, refund_amount_cents, payout_amount_cents, resolved_by, resolved_at, updated_at
          )
          SELECT ${caseId}, ${missionId}, ${user.id}, ${kind},
            ${immediateCancellation ? "resolved" : "open"}, ${previousStatus}, ${cleanSummary},
            ${immediateCancellation ? "cancel" : null}, ${refundAmountCents}, 0,
            ${immediateCancellation ? user.id : null}, ${immediateCancellation ? now : null}, ${now}
          FROM active_leg
          WHERE (${expectedBundleCount} = 0 OR EXISTS (SELECT 1 FROM updated_bundle))
            AND (SELECT COUNT(*) FROM updated_other_legs) = ${expectedOtherLegCount}
          RETURNING id
        ), attached_refunds AS (
          UPDATE payment_refunds AS refund
          SET mission_case_id = created_case.id,
              updated_at = ${now}
          FROM created_case
          WHERE ${reservedRefundPredicate}
            AND refund.mission_case_id IS NULL
            AND refund.stripe_refund_id IS NULL
            AND refund.status = 'pending'
            AND refund.reason = ${refundReason}
          RETURNING refund.id, refund.amount_cents
        ), audited AS (
          INSERT INTO mission_updates (mission_id, author_id, status, message)
          SELECT changed_leg.id, ${user.id}, ${nextStatus}, ${auditMessage}
          FROM (
            SELECT id FROM active_leg
            UNION ALL
            SELECT id FROM updated_other_legs
          ) AS changed_leg
          WHERE EXISTS (SELECT 1 FROM created_case)
          RETURNING id
        )
        SELECT CASE
          WHEN (SELECT COUNT(*) FROM active_leg) = 1
            AND (SELECT COUNT(*) FROM updated_bundle) = ${expectedBundleCount}
            AND (SELECT COUNT(*) FROM updated_other_legs) = ${expectedOtherLegCount}
            AND (SELECT COUNT(*) FROM created_case) = 1
            AND (SELECT COUNT(*) FROM attached_refunds) = ${expectedRefundCount}
            AND COALESCE((SELECT SUM(amount_cents) FROM attached_refunds), 0) = ${refundAmountCents}
            AND (SELECT COUNT(*) FROM audited) = ${expectedAuditCount}
          THEN (SELECT id::text FROM created_case)
          ELSE (
            1 / (
              (SELECT COUNT(*)::integer FROM created_case)
              - (SELECT COUNT(*)::integer FROM created_case)
            )
          )::text
        END AS id
      `);
    } catch (error) {
      if (reservedRefundIds.length) {
        try {
          await db.update(paymentRefunds).set({
            status: "canceled",
            failureCode: "cancellation_lifecycle_not_committed",
            failureMessage: "The cancellation lifecycle did not commit, so this unlinked refund reservation was released without contacting Stripe.",
            updatedAt: new Date(),
          }).where(and(
            inArray(paymentRefunds.id, reservedRefundIds),
            isNull(paymentRefunds.missionCaseId),
            isNull(paymentRefunds.stripeRefundId),
            eq(paymentRefunds.status, "pending"),
          ));
        } catch (cleanupError) {
          await reportException(cleanupError, { route: "operations.cancel_unlinked_refund_reservation", missionId, caseId });
        }
      }
      await reportUnexpectedAtomicFailure(error, "open_case", { missionId, kind });
      throw new Error("The mission changed in another window or already entered review. Refresh before trying again.");
    }

    if (refundAmountCents > 0) {
      try {
        await requestMissionRefund({
          missionId,
          amountCents: refundAmountCents,
          idempotencyKey: refundIdempotencyKey,
          missionCaseId: caseId,
          reason: refundReason,
        });
      } catch (error) {
        await reportException(error, { route: "operations.open_case_refund", missionId, caseId });
      }
    }

    const otherUserId = user.id === mission.customerId ? mission.scoutId : mission.customerId;
    if (otherUserId) await notifyUser({
      recipientUserId: otherUserId,
      missionId,
      kind: immediateCancellation ? "mission_cancelled" : "mission_review_opened",
      title: immediateCancellation ? "Mission cancelled" : "Mission paused for review",
      body: immediateCancellation ? "The customer cancelled before verified work began." : "A mission issue was reported. Control Room will review the mission record before work or payment continues.",
      actionLabel: "View mission",
      actionUrl: `https://sendascout.com/dashboard/missions/${missionId}`,
    });
    refreshOperations(missionId);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to submit this request." };
  }
}

export async function adminResolveMissionCase(
  caseId: string,
  resolution: CaseResolution,
  adminNotes: string,
  refundAmountCents = 0,
  payoutAmountCents = 0,
): Promise<Result> {
  try {
    const admin = await requireAdminUser();
    if (!(["resume", "cancel", "complete", "hold"] as string[]).includes(resolution)) throw new Error("Choose a valid case outcome.");
    const cleanNotes = adminNotes.trim();
    if (cleanNotes.length < 5) throw new Error("Add a brief internal resolution note.");
    if (cleanNotes.length > 3000) throw new Error("Resolution notes are limited to 3,000 characters.");
    const db = getDb();
    const [item] = await db.select({ case: missionCases, mission: missions, bundle: missionBundles }).from(missionCases)
      .innerJoin(missions, eq(missions.id, missionCases.missionId))
      .leftJoin(missionBundles, eq(missionBundles.id, missions.bundleId))
      .where(eq(missionCases.id, caseId)).limit(1);
    if (!item || item.case.status !== "open") throw new Error("This case is no longer open.");
    if (item.mission.archivedAt) throw new Error("Archived missions cannot be changed.");
    if (item.mission.status !== "disputed" || (item.bundle && item.bundle.status !== "disputed")) {
      throw new Error("The mission lifecycle no longer matches this open case. Refresh and review the mission history.");
    }
    const maximumRefundCents = item.bundle?.customerPriceCents ?? item.mission.customerPriceCents;
    const maximumPayoutCents = item.bundle?.scoutPayoutCents ?? item.mission.scoutPayoutCents;
    const [[recorded], [reservedForCase]] = await Promise.all([
      db.select({
      refundAmountCents: sql<number>`COALESCE(SUM(${missionCases.refundAmountCents}), 0)::integer`,
      payoutAmountCents: sql<number>`COALESCE(SUM(${missionCases.payoutAmountCents}), 0)::integer`,
      }).from(missionCases)
        .innerJoin(missions, eq(missions.id, missionCases.missionId))
        .where(and(
          eq(missionCases.status, "resolved"),
          item.bundle ? eq(missions.bundleId, item.bundle.id) : eq(missionCases.missionId, item.mission.id),
        )),
      db.select({
        refundAmountCents: sql<number>`COALESCE(SUM(${paymentRefunds.amountCents}), 0)::integer`,
      }).from(paymentRefunds).where(and(
        eq(paymentRefunds.missionCaseId, caseId),
        inArray(paymentRefunds.status, ["pending", "requires_action"]),
      )),
    ]);
    const refundCapacity = await getMissionRefundCapacity(item.mission.id);
    const remainingRefundCents = Math.min(
      remainingCaseAdjustmentCents(maximumRefundCents, Number(recorded?.refundAmountCents ?? 0)),
      refundCapacity.refundableCents + Number(reservedForCase?.refundAmountCents ?? 0),
    );
    const remainingPayoutCents = remainingCaseAdjustmentCents(maximumPayoutCents, Number(recorded?.payoutAmountCents ?? 0));
    if (!Number.isSafeInteger(refundAmountCents) || refundAmountCents < 0 || refundAmountCents > remainingRefundCents) {
      throw new Error(`Refund amount exceeds the remaining refundable balance of $${(remainingRefundCents / 100).toFixed(2)}.`);
    }
    if (!Number.isSafeInteger(payoutAmountCents) || payoutAmountCents < 0 || payoutAmountCents > remainingPayoutCents) {
      throw new Error(`Payout amount exceeds the remaining Scout balance of $${(remainingPayoutCents / 100).toFixed(2)}.`);
    }
    if (!caseResolutionIsFinal(resolution) && (refundAmountCents !== 0 || payoutAmountCents !== 0)) {
      throw new Error("Keep-paused reviews cannot record a refund or payout until a final outcome is selected.");
    }

    const requiresSecondAdmin = refundAmountCents > TWO_PERSON_REFUND_THRESHOLD_CENTS;
    if (requiresSecondAdmin) {
      const exactPendingProposal = item.case.resolution === resolution
        && item.case.refundAmountCents === refundAmountCents
        && item.case.payoutAmountCents === payoutAmountCents
        && Boolean(item.case.resolvedBy)
        && !item.case.resolvedAt;
      if (exactPendingProposal && item.case.resolvedBy === admin.id) {
        throw new Error("A different administrator must approve this high-value refund.");
      }
      if (!exactPendingProposal) {
        if (item.case.resolvedBy && item.case.resolvedBy !== admin.id) {
          throw new Error("Approve the exact high-value proposal already saved on this case, or ask its proposer to revise it.");
        }
        const proposalNote = `[${new Date().toISOString()}] High-value financial proposal by administrator ${admin.id}: outcome ${resolution}; customer refund $${(refundAmountCents / 100).toFixed(2)}; Scout payout $${(payoutAmountCents / 100).toFixed(2)}. A distinct second administrator must approve the unchanged proposal. Evidence note: ${cleanNotes}`;
        const now = new Date();
        try {
          await db.execute(sql`
            WITH saved_proposal AS (
              UPDATE mission_cases AS review_case
              SET resolution = ${resolution},
                  refund_amount_cents = ${refundAmountCents},
                  payout_amount_cents = ${payoutAmountCents},
                  admin_notes = CONCAT_WS(E'\n\n', NULLIF(review_case.admin_notes, ''), ${proposalNote}::text),
                  resolved_by = ${admin.id},
                  resolved_at = NULL,
                  updated_at = ${now}
              WHERE review_case.id = ${caseId}
                AND review_case.status = 'open'
                AND review_case.resolved_at IS NULL
                AND (review_case.resolved_by IS NULL OR review_case.resolved_by = ${admin.id})
              RETURNING id
            )
            SELECT CASE
              WHEN (SELECT COUNT(*) FROM saved_proposal) = 1 THEN 1
              ELSE 1 / (
                (SELECT COUNT(*)::integer FROM saved_proposal)
                - (SELECT COUNT(*)::integer FROM saved_proposal)
              )
            END AS saved
          `);
        } catch (error) {
          await reportUnexpectedAtomicFailure(error, "propose_case_adjustment", { caseId, missionId: item.mission.id });
          throw new Error("Another administrator changed this financial proposal. Refresh before reviewing it.");
        }
        refreshOperations(item.mission.id);
        return { ok: true };
      }
    }

    const nextStatus = missionStatusAfterResolution(resolution, item.case.previousMissionStatus as OperationalMissionStatus);
    const now = new Date();
    const bundleLegs = item.bundle
      ? await db.select({ id: missions.id, status: missions.status }).from(missions).where(and(eq(missions.bundleId, item.bundle.id), isNull(missions.archivedAt)))
      : [{ id: item.mission.id, status: item.mission.status }];
    if (resolution !== "hold") {
      const [activeProviderDispute] = await db.select({ id: paymentDisputes.id }).from(paymentDisputes)
        .innerJoin(payments, eq(payments.id, paymentDisputes.paymentId))
        .where(and(
          inArray(payments.missionId, bundleLegs.map((leg) => leg.id)),
          notInArray(paymentDisputes.status, ["won", "prevented", "warning_closed", "lost"]),
        ))
        .limit(1);
      if (activeProviderDispute) {
        throw new Error("Stripe is still reviewing the payment dispute. Keep this case paused until the provider reports a final outcome.");
      }
    }
    const targetLegs = item.bundle && resolution === "cancel"
      ? bundleLegs.filter((leg) => !["completed", "cancelled"].includes(leg.status))
      : item.bundle && resolution === "complete"
        ? bundleLegs.filter((leg) => !["completed", "cancelled"].includes(leg.status))
        : bundleLegs.filter((leg) => leg.id === item.mission.id);
    const expectedBundleCount = item.bundle ? 1 : 0;
    const shouldIncrementScoutCompletion = resolution === "complete"
      && item.case.previousMissionStatus !== "completed"
      && Boolean(item.mission.scoutId);
    const expectedScoutCount = shouldIncrementScoutCompletion ? 1 : 0;
    const noteEntry = `[${now.toISOString()}] ${resolution === "hold" ? "Kept paused" : `Resolved · ${resolution}`}: ${cleanNotes}`;
    const noActiveProviderDispute = resolution === "hold" ? sql`TRUE` : sql`NOT EXISTS (
      SELECT 1
      FROM payment_disputes AS active_dispute
      INNER JOIN payments AS disputed_payment ON disputed_payment.id = active_dispute.payment_id
      INNER JOIN missions AS disputed_mission ON disputed_mission.id = disputed_payment.mission_id
      WHERE active_dispute.status NOT IN ('won', 'lost', 'prevented', 'warning_closed')
        AND (
          (mission.bundle_id IS NULL AND disputed_mission.id = mission.id)
          OR (mission.bundle_id IS NOT NULL AND disputed_mission.bundle_id = mission.bundle_id)
        )
    )`;
    const lockedCaseCte = sql`
      locked_mission AS MATERIALIZED (
        SELECT mission.id AS mission_id, mission.bundle_id
        FROM missions AS mission
        WHERE mission.id = ${item.mission.id}
          AND mission.status = 'disputed'
          AND mission.archived_at IS NULL
          AND ${noActiveProviderDispute}
        FOR UPDATE OF mission
      )`;
    const lockedBundleCte = sql`
      locked_bundle AS MATERIALIZED (
        SELECT bundle.id
        FROM mission_bundles AS bundle
        INNER JOIN locked_mission ON locked_mission.bundle_id = bundle.id
        WHERE bundle.id = ${item.bundle?.id ?? null}
          AND bundle.status = 'disputed'
          AND bundle.active_sequence = ${item.bundle?.activeSequence ?? 0}
        FOR UPDATE OF bundle
      ), locked_case AS MATERIALIZED (
        SELECT review_case.id AS case_id, review_case.mission_id, locked_mission.bundle_id
        FROM mission_cases AS review_case
        INNER JOIN locked_mission ON locked_mission.mission_id = review_case.mission_id
        WHERE review_case.id = ${caseId}
          AND review_case.status = 'open'
          AND (
            locked_mission.bundle_id IS NULL
            OR EXISTS (SELECT 1 FROM locked_bundle)
          )
        FOR UPDATE OF review_case
      ), eligible_case AS (
        SELECT locked_case.*
        FROM locked_case
      )`;

    if (resolution === "hold") {
      try {
        await db.execute(sql`
          WITH ${lockedCaseCte}, ${lockedBundleCte}, kept_open AS (
            UPDATE mission_cases AS review_case
            SET admin_notes = CONCAT_WS(E'\n\n', NULLIF(review_case.admin_notes, ''), ${noteEntry}::text),
                resolution = NULL,
                refund_amount_cents = 0,
                payout_amount_cents = 0,
                resolved_by = NULL,
                resolved_at = NULL,
                updated_at = ${now}
            FROM eligible_case
            WHERE review_case.id = eligible_case.case_id
            RETURNING review_case.id, review_case.mission_id
          ), audited AS (
            INSERT INTO mission_updates (mission_id, author_id, status, message)
            SELECT kept_open.mission_id, ${admin.id}, 'disputed', 'Control Room reviewed the case and kept the mission paused.'
            FROM kept_open
            RETURNING id
          )
          SELECT CASE
            WHEN (SELECT COUNT(*) FROM kept_open) = 1
              AND (SELECT COUNT(*) FROM locked_bundle) = ${expectedBundleCount}
              AND (SELECT COUNT(*) FROM audited) = 1
            THEN (SELECT id::text FROM kept_open)
            ELSE (
              1 / (
                (SELECT COUNT(*)::integer FROM kept_open)
                - (SELECT COUNT(*)::integer FROM kept_open)
              )
            )::text
          END AS id
        `);
      } catch (error) {
        await reportUnexpectedAtomicFailure(error, "keep_case_paused", { caseId, missionId: item.mission.id });
        throw new Error("The case or mission changed in another window. Refresh before trying again.");
      }
    } else {
      if (refundAmountCents > 0) {
        await requestMissionRefund({
          missionId: item.mission.id,
          amountCents: refundAmountCents,
          idempotencyKey: `mission-case:${caseId}:refund:v1`,
          missionCaseId: caseId,
          reason: missionCaseRefundReason(caseId),
          deferProcessing: true,
        });
      }
      const targetPredicate = item.bundle && (resolution === "cancel" || resolution === "complete")
        ? sql`target.bundle_id = ${item.bundle.id} AND target.status NOT IN ('completed', 'cancelled')`
        : sql`target.id = ${item.mission.id} AND target.status = 'disputed'`;
      const nextBundleStatus = item.bundle
        ? bundleStatusAfterResolution(resolution, item.case.previousMissionStatus as OperationalMissionStatus, item.bundle.activeSequence)
        : "draft";
      const expectedTargetCount = targetLegs.length;
      try {
        await db.execute(sql`
          WITH ${lockedCaseCte}, ${lockedBundleCte}, locked_legs AS MATERIALIZED (
            SELECT target.id
            FROM missions AS target
            WHERE target.archived_at IS NULL
              AND ${targetPredicate}
              AND EXISTS (SELECT 1 FROM eligible_case)
            FOR UPDATE OF target
          ), resolved_case AS (
            UPDATE mission_cases AS review_case
            SET status = 'resolved',
                resolution = ${resolution},
                admin_notes = CONCAT_WS(E'\n\n', NULLIF(review_case.admin_notes, ''), ${noteEntry}::text),
                refund_amount_cents = ${refundAmountCents},
                payout_amount_cents = ${payoutAmountCents},
                resolved_by = ${admin.id},
                resolved_at = ${now},
                updated_at = ${now}
            FROM eligible_case
            WHERE review_case.id = eligible_case.case_id
              AND (SELECT COUNT(*) FROM locked_legs) = ${expectedTargetCount}
            RETURNING review_case.id
          ), updated_legs AS (
            UPDATE missions AS target
            SET status = ${nextStatus},
                completed_at = CASE WHEN ${nextStatus} = 'completed' THEN ${now} ELSE target.completed_at END,
                location_sharing_active = FALSE,
                scout_latitude = NULL,
                scout_longitude = NULL,
                scout_location_accuracy_meters = NULL,
                scout_location_updated_at = NULL,
                updated_at = ${now}
            FROM locked_legs
            WHERE target.id = locked_legs.id
              AND EXISTS (SELECT 1 FROM resolved_case)
            RETURNING target.id
          ), updated_bundle AS (
            UPDATE mission_bundles AS bundle
            SET status = ${nextBundleStatus},
                completed_at = CASE WHEN ${resolution} = 'complete' THEN ${now} ELSE bundle.completed_at END,
                updated_at = ${now}
            FROM locked_bundle
            WHERE bundle.id = locked_bundle.id
              AND EXISTS (SELECT 1 FROM resolved_case)
              AND (SELECT COUNT(*) FROM updated_legs) = ${expectedTargetCount}
            RETURNING bundle.id
          ), updated_scout AS (
            UPDATE scout_profiles AS profile
            SET completed_missions = profile.completed_missions + 1,
                updated_at = ${now}
            FROM (
              SELECT DISTINCT completed_leg.scout_id
              FROM missions AS completed_leg
              INNER JOIN updated_legs ON updated_legs.id = completed_leg.id
              WHERE completed_leg.scout_id IS NOT NULL
                AND ${resolution} = 'complete'
                AND ${item.case.previousMissionStatus} <> 'completed'
                AND (SELECT COUNT(*) FROM updated_legs) = ${expectedTargetCount}
                AND (${expectedBundleCount} = 0 OR EXISTS (SELECT 1 FROM updated_bundle))
            ) AS completed_booking
            WHERE profile.user_id = completed_booking.scout_id
            RETURNING profile.user_id
          ), audited AS (
            INSERT INTO mission_updates (mission_id, author_id, status, message)
            SELECT updated_legs.id, ${admin.id}, ${nextStatus}, ${`Control Room resolved the ${item.bundle ? "itinerary" : "mission"} case: ${resolution}.`}
            FROM updated_legs
            WHERE EXISTS (SELECT 1 FROM resolved_case)
              AND (${expectedBundleCount} = 0 OR EXISTS (SELECT 1 FROM updated_bundle))
            RETURNING id
          )
          SELECT CASE
            WHEN (SELECT COUNT(*) FROM resolved_case) = 1
              AND (SELECT COUNT(*) FROM locked_legs) = ${expectedTargetCount}
              AND (SELECT COUNT(*) FROM updated_legs) = ${expectedTargetCount}
              AND (SELECT COUNT(*) FROM updated_bundle) = ${expectedBundleCount}
              AND (SELECT COUNT(*) FROM updated_scout) = ${expectedScoutCount}
              AND (SELECT COUNT(*) FROM audited) = ${expectedTargetCount}
            THEN (SELECT id::text FROM resolved_case)
            ELSE (
              1 / (
                (SELECT COUNT(*)::integer FROM resolved_case)
                - (SELECT COUNT(*)::integer FROM resolved_case)
              )
            )::text
          END AS id
        `);
      } catch (error) {
        await reportUnexpectedAtomicFailure(error, "resolve_case", { caseId, missionId: item.mission.id, resolution });
        throw new Error("The case, mission, or financial balance changed in another window. Refresh before trying again.");
      }
    }
    if (resolution !== "hold" && refundAmountCents > 0) {
      try {
        await requestMissionRefund({
          missionId: item.mission.id,
          amountCents: refundAmountCents,
          idempotencyKey: `mission-case:${caseId}:refund:v1`,
          missionCaseId: caseId,
          reason: missionCaseRefundReason(caseId),
        });
      } catch (error) {
        await reportException(error, { route: "operations.resolve_case_refund", missionId: item.mission.id, caseId });
      }
    }
    if (resolution !== "hold" && payoutAmountCents > 0) {
      await settleCasePayoutBestEffort(caseId, "case_resolution");
    }

    const body = resolution === "resume" ? "Control Room reviewed the report and restored the mission."
      : resolution === "cancel" ? "Control Room reviewed the report and cancelled the mission."
      : resolution === "complete" ? "Control Room reviewed the mission and marked it complete."
      : "The mission remains paused while payment or safety review continues.";
    const notificationKind = resolution === "hold" ? "case_review_updated" : "case_resolved";
    const notificationTitle = resolution === "hold" ? "Mission review remains open" : "Mission review updated";
    await notifyUser({ recipientUserId: item.mission.customerId, missionId: item.mission.id, kind: notificationKind, title: notificationTitle, body, actionLabel: "View mission", actionUrl: `https://sendascout.com/dashboard/missions/${item.mission.id}` });
    if (item.mission.scoutId) await notifyUser({ recipientUserId: item.mission.scoutId, missionId: item.mission.id, kind: notificationKind, title: notificationTitle, body, actionLabel: "View mission", actionUrl: `https://sendascout.com/dashboard/missions/${item.mission.id}` });
    if (resolution === "complete" && refundAmountCents === 0 && payoutAmountCents === 0) {
      await settleMissionBestEffort(item.mission.id, "case_resolution");
    }
    for (const leg of bundleLegs) revalidatePath(`/dashboard/missions/${leg.id}`);
    refreshOperations(item.mission.id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to resolve this case." };
  }
}

export async function adminRetryNotification(id: string): Promise<Result> {
  try {
    await requireAdminUser();
    const [item] = await getDb().select({ missionId: notifications.missionId }).from(notifications).where(eq(notifications.id, id)).limit(1);
    await retryNotification(id);
    revalidatePath("/control-room");
    if (item?.missionId) revalidatePath(`/dashboard/missions/${item.missionId}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to retry this notification." };
  }
}

export async function adminArchiveMission(id: string, reason = "Archived from Control Room"): Promise<Result> {
  try {
    const admin = await requireAdminUser();
    const db = getDb();
    const [mission] = await db.select().from(missions).where(eq(missions.id, id)).limit(1);
    if (!mission) throw new Error("Mission not found.");
    const [bundle] = mission.bundleId
      ? await db.select().from(missionBundles).where(eq(missionBundles.id, mission.bundleId)).limit(1)
      : [null];
    const effectiveStatus = bundle?.status ?? mission.status;
    if (!['completed', 'cancelled', 'draft'].includes(effectiveStatus)) throw new Error("Cancel or complete an active mission before archiving it.");
    if (mission.archivedAt) throw new Error("This mission is already archived.");
    const cleanReason = reason.trim().slice(0, 500) || "Archived from Control Room";
    const now = new Date();
    const legs = bundle
      ? await db.select({ id: missions.id, status: missions.status }).from(missions).where(and(eq(missions.bundleId, bundle.id), isNull(missions.archivedAt)))
      : [{ id: mission.id, status: mission.status }];
    const legIds = legs.map((leg) => leg.id);
    const expectedBundleCount = bundle ? 1 : 0;
    const archiveScope = bundle
      ? sql`candidate.bundle_id = ${bundle.id} AND EXISTS (SELECT 1 FROM locked_bundle)`
      : sql`candidate.id = (SELECT id FROM locked_anchor) AND candidate.status = ${mission.status}`;
    try {
      await db.execute(sql`
        WITH locked_anchor AS MATERIALIZED (
          SELECT anchor.id, anchor.bundle_id
          FROM missions AS anchor
          WHERE anchor.id = ${mission.id}
            AND anchor.archived_at IS NULL
            AND anchor.status = ${mission.status}
          FOR UPDATE OF anchor
        ), locked_bundle AS MATERIALIZED (
          SELECT bundle.id
          FROM mission_bundles AS bundle
          INNER JOIN locked_anchor ON locked_anchor.bundle_id = bundle.id
          WHERE bundle.id = ${bundle?.id ?? null}
            AND bundle.status = ${bundle?.status ?? "draft"}
            AND bundle.status IN ('completed', 'cancelled', 'draft')
          FOR UPDATE OF bundle
        ), locked_legs AS MATERIALIZED (
          SELECT candidate.id, candidate.status
          FROM missions AS candidate
          WHERE candidate.archived_at IS NULL
            AND ${archiveScope}
          FOR UPDATE OF candidate
        ), archived AS (
          UPDATE missions AS candidate
          SET archived_at = ${now}, archived_reason = ${cleanReason}, updated_at = ${now}
          FROM locked_legs
          WHERE candidate.id = locked_legs.id
            AND locked_legs.status IN ('completed', 'cancelled', 'draft')
          RETURNING candidate.id, candidate.status
        ), audited AS (
          INSERT INTO mission_updates (mission_id, author_id, status, message)
          SELECT archived.id, ${admin.id}, archived.status, ${`Mission itinerary archived: ${cleanReason}`}
          FROM archived
          RETURNING id
        ), cleared_notifications AS (
          UPDATE notifications AS notice
          SET read_at = ${now}
          WHERE notice.mission_id IN (SELECT id FROM archived)
          RETURNING notice.id
        )
        SELECT CASE
          WHEN (SELECT COUNT(*) FROM locked_anchor) = 1
            AND (SELECT COUNT(*) FROM locked_bundle) = ${expectedBundleCount}
            AND (SELECT COUNT(*) FROM locked_legs) = ${legIds.length}
            AND (SELECT COUNT(*) FROM archived) = ${legIds.length}
            AND (SELECT COUNT(*) FROM audited) = ${legIds.length}
          THEN (SELECT id::text FROM archived LIMIT 1)
          ELSE (
            1 / (
              (SELECT COUNT(*)::integer FROM archived)
              - (SELECT COUNT(*)::integer FROM archived)
            )
          )::text
        END AS id
      `);
    } catch (error) {
      await reportUnexpectedAtomicFailure(error, "archive_mission", { missionId: id, bundleId: bundle?.id ?? null });
      throw new Error("The mission changed in another window and was not archived. Refresh before trying again.");
    }
    for (const leg of legs) revalidatePath(`/dashboard/missions/${leg.id}`);
    refreshOperations(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to archive this mission." };
  }
}

export async function adminSetOperationalEventStatus(id: string, status: "acknowledged" | "resolved"): Promise<Result> {
  try {
    const admin = await requireAdminUser();
    const now = new Date();
    await getDb().update(operationalEvents).set({
      status,
      acknowledgedAt: now,
      acknowledgedBy: admin.id,
      resolvedAt: status === "resolved" ? now : null,
    }).where(eq(operationalEvents.id, id));
    revalidatePath("/control-room");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to update this operational alert." };
  }
}
