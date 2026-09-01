import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { missionRecurrences, missions } from "@/db/schema";
import { nextRecurrenceDate } from "@/lib/mission-features";
import { alertEligibleScouts, notifyUser } from "@/lib/notifications";
import { reportException, runOperationalHealthChecks } from "@/lib/observability";
import { reconcileScoutPayoutReadiness } from "@/lib/stripe-connect-service";
import { reconcileLatePaymentRefunds } from "@/lib/stripe-late-payment-refunds";
import { reconcileAmbiguousOffSessionPayments, reconcilePendingTipPayments } from "@/lib/stripe-payment-addons";
import { reconcilePaidAddonApplications } from "@/lib/stripe-payments";
import {
  processPendingPaymentRefunds,
  processPendingPaymentTransferReversals,
  reconcileApprovedSupportRefunds,
  reconcileMissionCaseRefunds,
} from "@/lib/stripe-refunds";
import {
  processPendingPaymentTransfers,
  reconcileCasePayouts,
  reconcileCompletedMissionSettlements,
  reconcileSettledPaymentTransfers,
  settleMissionBestEffort,
} from "@/lib/stripe-settlement";

export const maxDuration = 300;

export async function GET(request: Request) {
  const startedAt = Date.now();
  const requestId = request.headers.get("x-vercel-id") ?? crypto.randomUUID();
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  console.log(JSON.stringify({ level: "info", message: "hourly operations started", route: "/api/cron/auto-complete", requestId }));
  try {
    const db = getDb();
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const pending = await db.select().from(missions).where(and(sql`${missions.archivedAt} IS NULL`, eq(missions.status, "submitted"), lte(missions.submittedAt, cutoff)));
    let completed = 0;
    for (const mission of pending) {
      const now = new Date();
      const completionResult = await db.execute<{ mission_count: number }>(sql`
        WITH completed_mission AS (
          UPDATE missions AS target
          SET status = 'completed', completed_at = ${now}, updated_at = ${now}
          WHERE target.id = ${mission.id}
            AND target.status = 'submitted'
            AND target.archived_at IS NULL
            AND (
              target.bundle_id IS NULL
              OR EXISTS (
                SELECT 1 FROM mission_bundles AS parent
                WHERE parent.id = target.bundle_id AND parent.status = 'submitted'
              )
            )
          RETURNING target.id
        ), completed_bundle AS (
          UPDATE mission_bundles AS parent
          SET status = 'completed', completed_at = ${now}, updated_at = ${now}
          WHERE parent.id = ${mission.bundleId}
            AND parent.status = 'submitted'
            AND EXISTS (SELECT 1 FROM completed_mission)
          RETURNING parent.id
        ), accepted_result AS (
          UPDATE mission_part_results AS result
          SET status = 'accepted', accepted_at = ${now}, updated_at = ${now}
          FROM completed_mission
          WHERE result.mission_id = completed_mission.id
            AND result.status = 'submitted'
          RETURNING result.id
        ), updated_profile AS (
          UPDATE scout_profiles AS profile
          SET completed_missions = profile.completed_missions + 1, updated_at = ${now}
          WHERE profile.user_id = ${mission.scoutId}
            AND EXISTS (SELECT 1 FROM completed_mission)
          RETURNING profile.user_id
        ), inserted_update AS (
          INSERT INTO mission_updates (mission_id, status, message)
          SELECT id, 'completed'::mission_status, 'Automatically approved 24 hours after results were submitted.'
          FROM completed_mission
          RETURNING id
        ), counts AS (
          SELECT
            (SELECT COUNT(*)::integer FROM completed_mission) AS mission_count,
            (SELECT COUNT(*)::integer FROM completed_bundle) AS bundle_count,
            (SELECT COUNT(*)::integer FROM updated_profile) AS profile_count,
            (SELECT COUNT(*)::integer FROM inserted_update) AS update_count
        )
        SELECT mission_count,
          1 / CASE
            WHEN mission_count = 0 THEN 1
            WHEN bundle_count = ${mission.bundleId ? 1 : 0}
              AND profile_count = ${mission.scoutId ? 1 : 0}
              AND update_count = 1 THEN 1
            ELSE 0
          END AS invariant
        FROM counts
      `);
      const completionRows = completionResult.rows;
      if (Number(completionRows[0]?.mission_count ?? 0) !== 1) continue;
      if (mission.scoutId) await notifyUser({ recipientUserId: mission.scoutId, missionId: mission.id, kind: "mission_auto_confirmed", title: "Mission automatically confirmed", body: "The 24-hour customer review window ended, so the mission is now complete.", actionLabel: "View earnings", actionUrl: "https://sendascout.com/dashboard/scout/earnings" });
      await notifyUser({ recipientUserId: mission.customerId, missionId: mission.id, kind: "mission_auto_confirmed", title: "Mission automatically completed", body: "The mission was automatically completed after the 24-hour review window. Contact support promptly if there is a problem.", actionLabel: "View mission", actionUrl: `https://sendascout.com/dashboard/missions/${mission.id}` });
      await settleMissionBestEffort(mission.id, "automatic_confirmation");
      completed += 1;
    }

    const now = new Date();
    const preferredReleases = await db.select({ id: missions.id }).from(missions).where(and(
      sql`${missions.archivedAt} IS NULL`,
      eq(missions.status, "open"),
      eq(missions.paymentStatus, "paid"),
      lte(missions.preferredScoutExclusiveUntil, now),
      isNull(missions.preferredScoutBroadcastAt),
    ));
    let preferredBroadcasts = 0;
    for (const candidate of preferredReleases) {
      const [released] = await db.update(missions).set({ preferredScoutBroadcastAt: now, updatedAt: now }).where(and(
        eq(missions.id, candidate.id),
        eq(missions.status, "open"),
        eq(missions.paymentStatus, "paid"),
        isNull(missions.preferredScoutBroadcastAt),
      )).returning({ id: missions.id });
      if (!released) continue;
      await alertEligibleScouts(released.id);
      preferredBroadcasts += 1;
    }

    const dueRecurrences = await db.select().from(missionRecurrences).where(and(
      eq(missionRecurrences.status, "active"),
      lte(missionRecurrences.nextRunAt, now),
    ));
    let recurringReminders = 0;
    for (const recurrence of dueRecurrences) {
      if (!recurrence.nextRunAt) continue;
      const occurrenceAt = recurrence.nextRunAt;
      if (recurrence.endsAt && occurrenceAt > recurrence.endsAt) {
        await db.update(missionRecurrences).set({ status: "ended", nextRunAt: null, updatedAt: now }).where(and(
          eq(missionRecurrences.id, recurrence.id),
          eq(missionRecurrences.status, "active"),
          eq(missionRecurrences.nextRunAt, occurrenceAt),
        ));
        continue;
      }
      const calculatedNext = nextRecurrenceDate(occurrenceAt, recurrence.recurrenceRule, {
        timeZone: recurrence.timezone,
        anchor: recurrence.startsAt,
      });
      const ended = Boolean(recurrence.endsAt && calculatedNext.getTime() > recurrence.endsAt.getTime());
      const [advanced] = await db.update(missionRecurrences).set({
        status: ended ? "ended" : "active",
        lastRunAt: occurrenceAt,
        nextRunAt: ended ? null : calculatedNext,
        updatedAt: now,
      }).where(and(
        eq(missionRecurrences.id, recurrence.id),
        eq(missionRecurrences.status, "active"),
        eq(missionRecurrences.nextRunAt, occurrenceAt),
      )).returning({ id: missionRecurrences.id });
      if (!advanced) continue;
      const [publishedOccurrence] = await db.select({ id: missions.id }).from(missions).where(and(
        eq(missions.customerId, recurrence.customerId),
        eq(missions.recurrenceId, recurrence.id),
        eq(missions.recurrenceOccurrenceAt, occurrenceAt),
      )).limit(1);
      if (!publishedOccurrence) {
        await notifyUser({
          recipientUserId: recurrence.customerId,
          kind: "recurring_mission_ready",
          title: "Your recurring mission is ready to review",
          body: "Review the saved details and current price before publishing this occurrence. No charge or Scout assignment has been created yet.",
          actionLabel: "Review request",
          actionUrl: `https://sendascout.com/request?template=${recurrence.templateId}&recurrence=${recurrence.id}&occurrence=${encodeURIComponent(occurrenceAt.toISOString())}`,
        });
        recurringReminders += 1;
      }
    }
    const payoutReadinessReconciliation = await reconcileScoutPayoutReadiness();
    const settledTransferReconciliation = await reconcileSettledPaymentTransfers();
    const pendingTipReconciliation = await reconcilePendingTipPayments();
    const ambiguousOffSessionReconciliation = await reconcileAmbiguousOffSessionPayments();
    const paidAddonApplicationReconciliation = await reconcilePaidAddonApplications();
    const latePaymentRefundReconciliation = await reconcileLatePaymentRefunds();
    const caseRefundReconciliation = await reconcileMissionCaseRefunds();
    const supportRefundReconciliation = await reconcileApprovedSupportRefunds();
    const refunds = await processPendingPaymentRefunds();
    const transferReversals = await processPendingPaymentTransferReversals();
    const casePayoutReconciliation = await reconcileCasePayouts();
    const settlementReconciliation = await reconcileCompletedMissionSettlements();
    const transfers = await processPendingPaymentTransfers();
    const health = await runOperationalHealthChecks();
    console.log(JSON.stringify({ level: "info", message: "hourly operations completed", route: "/api/cron/auto-complete", requestId, completed, preferredBroadcasts, recurringReminders, payoutReadinessReconciliation, settledTransferReconciliation, pendingTipReconciliation, ambiguousOffSessionReconciliation, paidAddonApplicationReconciliation, latePaymentRefundReconciliation, caseRefundReconciliation, supportRefundReconciliation, refunds, transferReversals, casePayoutReconciliation, settlementReconciliation, transfers, health, durationMs: Date.now() - startedAt }));
    return NextResponse.json({ ok: true, completed, preferredBroadcasts, recurringReminders, payoutReadinessReconciliation, settledTransferReconciliation, pendingTipReconciliation, ambiguousOffSessionReconciliation, paidAddonApplicationReconciliation, latePaymentRefundReconciliation, caseRefundReconciliation, supportRefundReconciliation, refunds, transferReversals, casePayoutReconciliation, settlementReconciliation, transfers, health });
  } catch (error) {
    await reportException(error, { route: "/api/cron/auto-complete", requestId, durationMs: Date.now() - startedAt });
    return NextResponse.json({ ok: false, error: "Operations check failed." }, { status: 500 });
  }
}
