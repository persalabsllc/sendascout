import { and, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { Dashboard, type DashboardMission, type DashboardNotification } from "@/components/dashboard";
import { getDb } from "@/db";
import { missionBundles, missions, notifications, scoutProfiles } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";
import { isMissionEligibleForScout } from "@/lib/scout-matching";
import { scoutConnectReady } from "@/lib/stripe-connect";
import { getStripeLivemode } from "@/lib/stripe";

export const metadata = { title: "Scout Dashboard | Send a Scout", robots: { index: false, follow: false } };

export default async function ScoutDashboard() {
  const user = await requireAppUser("scout");
  const db = getDb();
  const [profileRow] = await db.select({
    profile: scoutProfiles,
    showApprovalBanner: sql<boolean>`${scoutProfiles.status} <> 'approved' OR (${scoutProfiles.approvedAt} IS NOT NULL AND ${scoutProfiles.approvedAt} > now() - interval '24 hours')`,
  }).from(scoutProfiles).where(eq(scoutProfiles.userId, user.id)).limit(1);
  if (!profileRow) redirect("/scout");
  const profile = profileRow.profile;
  const stripeLivemode = getStripeLivemode();
  const [rows, alertRows] = await Promise.all([
    profile.status === "approved" && scoutConnectReady(profile, stripeLivemode)
      ? db.select().from(missions).where(and(isNull(missions.archivedAt), or(
        eq(missions.scoutId, user.id),
        and(eq(missions.status, "open"), eq(missions.paymentStatus, "paid"), or(
          isNull(missions.preferredScoutId),
          eq(missions.preferredScoutId, user.id),
          isNotNull(missions.preferredScoutBroadcastAt),
          lte(missions.preferredScoutExclusiveUntil, sql`now()`),
        )),
      ))).orderBy(desc(missions.createdAt))
      : db.select().from(missions).where(and(isNull(missions.archivedAt), eq(missions.scoutId, user.id))).orderBy(desc(missions.createdAt)),
    db.select().from(notifications).where(and(eq(notifications.recipientUserId, user.id), eq(notifications.channel, "in_app"), isNull(notifications.readAt))).orderBy(desc(notifications.createdAt)).limit(5),
  ]);
  const bundleIds = [...new Set(rows.flatMap((mission) => mission.bundleId ? [mission.bundleId] : []))];
  const [bundleRows, bundleLegs] = bundleIds.length
    ? await Promise.all([
      db.select().from(missionBundles).where(inArray(missionBundles.id, bundleIds)),
      db.select().from(missions).where(and(inArray(missions.bundleId, bundleIds), isNull(missions.archivedAt))),
    ])
    : [[], []];
  const bundleById = new Map(bundleRows.map((bundle) => [bundle.id, bundle]));
  const legsByBundle = new Map<string, typeof bundleLegs>();
  for (const leg of bundleLegs) {
    if (!leg.bundleId) continue;
    const list = legsByBundle.get(leg.bundleId) ?? [];
    list.push(leg);
    legsByBundle.set(leg.bundleId, list);
  }
  const visibleRows = rows.filter((mission) => {
    if (mission.bundleId) {
      const bundle = bundleById.get(mission.bundleId);
      if (!bundle || bundle.paymentStatus !== "paid" || mission.bundleSequence !== bundle.activeSequence) return false;
    }
    return true;
  });
  const eligibleRows = visibleRows.filter((mission) => {
    if (mission.scoutId === user.id) return true;
    const legs = mission.bundleId ? legsByBundle.get(mission.bundleId) ?? [mission] : [mission];
    return legs.every((leg) => isMissionEligibleForScout(leg, profile));
  });
  const dashboardMissions: DashboardMission[] = eligibleRows.map((mission) => ({
    id: mission.id, type: mission.type, title: mission.title,
    place: `${mission.city}, ${mission.state} ${mission.zip}`,
    status: mission.status, time: mission.scheduledFor ? mission.scheduledFor.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "ASAP",
    payoutCents: mission.bundleId ? bundleById.get(mission.bundleId)?.scoutPayoutCents ?? mission.scoutPayoutCents : mission.scoutPayoutCents,
    assigned: mission.scoutId === user.id,
  }));
  const name = user.firstName || "Scout";
  const initials = `${user.firstName?.[0] ?? ""}${user.lastName?.[0] ?? ""}`.toUpperCase() || "SA";
  const missionById = new Map(visibleRows.map((mission) => [mission.id, mission]));
  const dashboardNotifications: DashboardNotification[] = alertRows
    .filter((item) => {
      if (!item.missionId) return true;
      const mission = missionById.get(item.missionId);
      if (item.kind === "new_mission") return mission?.status === "open";
      return !mission || !["completed", "cancelled", "disputed"].includes(mission.status);
    })
    .map((item) => ({ id: item.id, title: item.title, body: item.body, missionId: item.missionId, createdAt: item.createdAt.toISOString() }));
  return <Dashboard role="scout" userName={name} initials={initials} missions={dashboardMissions} notifications={dashboardNotifications} profileStatus={profile.status} showScoutBanner={profileRow.showApprovalBanner} />;
}
