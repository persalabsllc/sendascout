import { and, desc, eq, isNull } from "drizzle-orm";
import { Dashboard, type DashboardMission, type DashboardNotification } from "@/components/dashboard";
import { getDb } from "@/db";
import { missionBundles, missions, notifications } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";
import { redirect } from "next/navigation";

export const metadata = { title: "Customer Dashboard | Send a Scout", robots: { index: false, follow: false } };

export default async function CustomerDashboard() {
  const user = await requireAppUser("customer");
  if (!user.profileCompletedAt) redirect("/dashboard/customer/profile?next=/dashboard/customer");
  const db = getDb();
  const [rows, alertRows] = await Promise.all([
    db.select({ mission: missions, bundle: missionBundles }).from(missions).leftJoin(missionBundles, eq(missions.bundleId, missionBundles.id)).where(and(eq(missions.customerId, user.id), isNull(missions.archivedAt))).orderBy(desc(missions.createdAt)),
    db.select().from(notifications).where(and(eq(notifications.recipientUserId, user.id), eq(notifications.channel, "in_app"), isNull(notifications.readAt))).orderBy(desc(notifications.createdAt)).limit(5),
  ]);
  const dashboardMissions: DashboardMission[] = rows.filter(({ mission }) => !mission.bundleId || mission.bundleSequence === 1).map(({ mission, bundle }) => {
    const activeLeg = mission.bundleId
      ? rows.find((row) => row.mission.bundleId === mission.bundleId && row.mission.bundleSequence === (bundle?.activeSequence ?? 1))?.mission ?? mission
      : mission;
    const bundleParts = mission.bundleId ? rows.filter((row) => row.mission.bundleId === mission.bundleId).length : undefined;
    return {
      id: activeLeg.id,
      type: activeLeg.type,
      title: activeLeg.title,
      place: `${activeLeg.city}, ${activeLeg.state} ${activeLeg.zip}`,
      status: activeLeg.status,
      time: activeLeg.scheduledFor ? activeLeg.scheduledFor.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "ASAP",
      bundleParts,
      bundleLabel: bundleParts && bundleParts > 1
        ? `${missionLabel(mission.type)} + Move It · ${bundleParts} parts · Active: ${missionLabel(activeLeg.type)}`
        : undefined,
    };
  });
  const name = user.firstName || "";
  const initials = `${user.firstName?.[0] ?? ""}${user.lastName?.[0] ?? ""}`.toUpperCase() || "SA";
  const dashboardNotifications: DashboardNotification[] = alertRows.map((item) => ({ id: item.id, title: item.title, body: item.body, missionId: item.missionId, createdAt: item.createdAt.toISOString() }));
  return <Dashboard role="customer" userName={name} initials={initials} missions={dashboardMissions} notifications={dashboardNotifications} />;
}

function missionLabel(type: "see" | "move" | "meet") {
  return type === "see" ? "See It" : type === "move" ? "Move It" : "Meet It";
}
