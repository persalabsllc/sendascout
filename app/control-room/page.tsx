import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { ControlRoom } from "@/components/control-room";
import { getDb } from "@/db";
import { missionBundles, missionCases, missions, notifications, operationalEvents, scoutProfiles, users } from "@/db/schema";
import { requireAdminUser } from "@/lib/app-user";

export const metadata = { title: "Control Room | Send a Scout", robots: { index: false, follow: false } };

export default async function ControlRoomPage() {
  const admin = await requireAdminUser();
  const db = getDb();
  const [missionRows, caseRows, messageRows, eventRows, [newCustomerCount], [newScoutCount]] = await Promise.all([
    db.select({ mission: missions, customer: users, bundle: missionBundles }).from(missions)
      .innerJoin(users, eq(users.id, missions.customerId))
      .leftJoin(missionBundles, eq(missionBundles.id, missions.bundleId))
      .where(isNull(missions.archivedAt)).orderBy(desc(missions.createdAt)),
    db.select({
      case: missionCases,
      mission: missions,
      bundle: missionBundles,
      reporter: users,
      recordedRefundAmountCents: sql<number>`COALESCE((
        SELECT SUM(previous_case.refund_amount_cents)
        FROM mission_cases AS previous_case
        INNER JOIN missions AS previous_mission ON previous_mission.id = previous_case.mission_id
        WHERE previous_case.status = 'resolved'
          AND (
            (${missions.bundleId} IS NOT NULL AND previous_mission.bundle_id = ${missions.bundleId})
            OR (${missions.bundleId} IS NULL AND previous_case.mission_id = ${missions.id})
          )
      ), 0)::integer`,
      recordedPayoutAmountCents: sql<number>`COALESCE((
        SELECT SUM(previous_case.payout_amount_cents)
        FROM mission_cases AS previous_case
        INNER JOIN missions AS previous_mission ON previous_mission.id = previous_case.mission_id
        WHERE previous_case.status = 'resolved'
          AND (
            (${missions.bundleId} IS NOT NULL AND previous_mission.bundle_id = ${missions.bundleId})
            OR (${missions.bundleId} IS NULL AND previous_case.mission_id = ${missions.id})
          )
      ), 0)::integer`,
    }).from(missionCases)
      .innerJoin(missions, eq(missions.id, missionCases.missionId))
      .leftJoin(missionBundles, eq(missionBundles.id, missions.bundleId))
      .innerJoin(users, eq(users.id, missionCases.reporterId))
      .orderBy(desc(missionCases.createdAt)).limit(40),
    db.select({ notification: notifications, recipient: users }).from(notifications)
      .innerJoin(users, eq(users.id, notifications.recipientUserId))
      .where(or(eq(notifications.channel, "email"), eq(notifications.channel, "sms")))
      .orderBy(desc(notifications.createdAt)).limit(40),
    db.select().from(operationalEvents).orderBy(desc(operationalEvents.lastSeenAt)).limit(40),
    db.select({ count: sql<number>`count(*)::int` }).from(users).where(and(eq(users.role, "customer"), sql`${users.createdAt} > now() - interval '24 hours'`)),
    db.select({ count: sql<number>`count(*)::int` }).from(scoutProfiles).where(sql`${scoutProfiles.createdAt} > now() - interval '24 hours'`),
  ]);
  const visibleMissionRows = missionRows.filter(({ mission, bundle }) => !bundle || mission.bundleSequence === bundle.activeSequence);
  const activeStatuses = ["claimed", "en_route", "onsite", "en_route_pickup", "at_pickup", "en_route_dropoff", "at_dropoff", "submitted"] as const;
  return <ControlRoom
    stats={{
      newCustomers: newCustomerCount?.count ?? 0,
      newScouts: newScoutCount?.count ?? 0,
      open: visibleMissionRows.filter(({ mission, bundle }) => (bundle?.status ?? mission.status) === "open").length,
      active: visibleMissionRows.filter(({ mission, bundle }) => activeStatuses.includes((bundle?.status ?? mission.status) as typeof activeStatuses[number]) || bundle?.status === "in_progress").length,
      cases: caseRows.filter(({ case: item }) => item.status === "open").length,
      failedMessages: messageRows.filter(({ notification }) => notification.status === "failed").length,
    }}
    missions={visibleMissionRows.map(({ mission, customer, bundle }) => ({
      id: mission.id,
      title: bundle?.title ?? mission.title,
      type: mission.type,
      status: bundle?.status ?? mission.status,
      paymentStatus: bundle?.paymentStatus ?? mission.paymentStatus,
      customer: [customer.firstName, customer.lastName].filter(Boolean).join(" ") || customer.email,
      location: `${mission.city}, ${mission.state} ${mission.zip}`,
      price: bundle?.customerPriceCents ?? mission.customerPriceCents,
      payout: bundle?.scoutPayoutCents ?? mission.scoutPayoutCents,
      routeMiles: mission.routeDistanceMeters ? Math.max(1, Math.ceil(mission.routeDistanceMeters / 1609.344)) : null,
      routeVerified: mission.routeSource === "google",
      authorizedMinutes: mission.meetAuthorizedMinutes,
      createdAt: mission.createdAt.toISOString(),
    }))}
    cases={caseRows.map(({ case: item, mission, bundle, reporter, recordedRefundAmountCents, recordedPayoutAmountCents }) => ({
      id: item.id,
      missionId: mission.id,
      missionTitle: bundle?.title ?? mission.title,
      kind: item.kind,
      status: item.status,
      previousMissionStatus: item.previousMissionStatus,
      summary: item.summary,
      reporter: [reporter.firstName, reporter.lastName].filter(Boolean).join(" ") || reporter.email,
      adminNotes: item.adminNotes,
      resolution: item.resolution,
      refundAmountCents: item.refundAmountCents,
      payoutAmountCents: item.payoutAmountCents,
      financialApprovalPending: item.status === "open"
        && item.refundAmountCents > 10_000
        && Boolean(item.resolvedBy)
        && !item.resolvedAt,
      proposedByCurrentAdmin: item.resolvedBy === admin.id,
      createdAt: item.createdAt.toISOString(),
      resolvedAt: item.resolvedAt?.toISOString() ?? null,
      customerPriceCents: Math.max(0, (bundle?.customerPriceCents ?? mission.customerPriceCents) - Number(recordedRefundAmountCents ?? 0)),
      scoutPayoutCents: Math.max(0, (bundle?.scoutPayoutCents ?? mission.scoutPayoutCents) - Number(recordedPayoutAmountCents ?? 0)),
    }))}
    messageNotifications={messageRows.map(({ notification, recipient }) => ({
      id: notification.id,
      channel: notification.channel,
      recipient: notification.channel === "sms" ? recipient.phone ?? recipient.email : recipient.email,
      title: notification.title,
      status: notification.status,
      error: notification.error,
      attempts: notification.attemptCount,
      providerAccepted: Boolean(notification.providerMessageId),
      lastAttemptAt: notification.lastAttemptAt?.toISOString() ?? null,
      createdAt: notification.createdAt.toISOString(),
      sentAt: notification.sentAt?.toISOString() ?? null,
    }))}
    sentMode={process.env.SENT_DM_SMS_MODE === "live" ? "Live" : process.env.SENT_DM_SMS_MODE === "sandbox" ? "Sandbox" : "Disabled"}
    operationalEvents={eventRows.map((event) => ({
      id: event.id,
      severity: event.severity,
      category: event.category,
      message: event.message,
      status: event.status,
      occurrenceCount: event.occurrenceCount,
      lastSeenAt: event.lastSeenAt.toISOString(),
      alertedAt: event.alertedAt?.toISOString() ?? null,
    }))}
  />;
}
