import { and, desc, eq, isNull, or } from "drizzle-orm";
import { redirect } from "next/navigation";
import { Dashboard, type DashboardMission, type DashboardNotification } from "@/components/dashboard";
import { getDb } from "@/db";
import { missions, notifications, scoutProfiles } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";
import { isMissionEligibleForScout } from "@/lib/scout-matching";

export const metadata = { title: "Scout Dashboard | Send a Scout", robots: { index: false, follow: false } };

export default async function ScoutDashboard() {
  const user = await requireAppUser("scout");
  const db = getDb();
  const [profile] = await db.select().from(scoutProfiles).where(eq(scoutProfiles.userId, user.id)).limit(1);
  if (!profile) redirect("/scout");
  const [rows, alertRows] = await Promise.all([
    profile.status === "approved"
      ? db.select().from(missions).where(or(eq(missions.status, "open"), eq(missions.scoutId, user.id))).orderBy(desc(missions.createdAt))
      : db.select().from(missions).where(eq(missions.scoutId, user.id)).orderBy(desc(missions.createdAt)),
    db.select().from(notifications).where(and(eq(notifications.recipientUserId, user.id), eq(notifications.channel, "in_app"), isNull(notifications.readAt))).orderBy(desc(notifications.createdAt)).limit(5),
  ]);
  const eligibleRows = rows.filter((mission) => mission.scoutId === user.id || isMissionEligibleForScout(mission, profile));
  const dashboardMissions: DashboardMission[] = eligibleRows.map((mission) => ({
    id: mission.id, type: mission.type, title: mission.title,
    place: `${mission.city}, ${mission.state} ${mission.zip}`,
    status: mission.status, time: mission.scheduledFor ? mission.scheduledFor.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "ASAP",
    payoutCents: mission.scoutPayoutCents,
    assigned: mission.scoutId === user.id,
  }));
  const name = user.firstName || "Scout";
  const initials = `${user.firstName?.[0] ?? ""}${user.lastName?.[0] ?? ""}`.toUpperCase() || "SA";
  const missionById = new Map(rows.map((mission) => [mission.id, mission]));
  const dashboardNotifications: DashboardNotification[] = alertRows
    .filter((item) => {
      if (!item.missionId) return true;
      const mission = missionById.get(item.missionId);
      if (item.kind === "new_mission") return mission?.status === "open";
      return !mission || !["completed", "cancelled", "disputed"].includes(mission.status);
    })
    .map((item) => ({ id: item.id, title: item.title, body: item.body, missionId: item.missionId, createdAt: item.createdAt.toISOString() }));
  return <Dashboard role="scout" userName={name} initials={initials} missions={dashboardMissions} notifications={dashboardNotifications} profileStatus={profile.status} />;
}
