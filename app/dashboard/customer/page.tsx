import { and, desc, eq, isNull } from "drizzle-orm";
import { Dashboard, type DashboardMission, type DashboardNotification } from "@/components/dashboard";
import { getDb } from "@/db";
import { missions, notifications } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";
import { redirect } from "next/navigation";

export const metadata = { title: "Customer Dashboard | Send a Scout", robots: { index: false, follow: false } };

export default async function CustomerDashboard() {
  const user = await requireAppUser("customer");
  if (!user.profileCompletedAt) redirect("/dashboard/customer/profile?next=/dashboard/customer");
  const db = getDb();
  const [rows, alertRows] = await Promise.all([
    db.select().from(missions).where(eq(missions.customerId, user.id)).orderBy(desc(missions.createdAt)),
    db.select().from(notifications).where(and(eq(notifications.recipientUserId, user.id), eq(notifications.channel, "in_app"), isNull(notifications.readAt))).orderBy(desc(notifications.createdAt)).limit(5),
  ]);
  const dashboardMissions: DashboardMission[] = rows.map((mission) => ({
    id: mission.id, type: mission.type, title: mission.title,
    place: `${mission.city}, ${mission.state} ${mission.zip}`,
    status: mission.status,
    time: mission.scheduledFor ? mission.scheduledFor.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "ASAP",
  }));
  const name = user.firstName || "";
  const initials = `${user.firstName?.[0] ?? ""}${user.lastName?.[0] ?? ""}`.toUpperCase() || "SA";
  const dashboardNotifications: DashboardNotification[] = alertRows.map((item) => ({ id: item.id, title: item.title, body: item.body, missionId: item.missionId, createdAt: item.createdAt.toISOString() }));
  return <Dashboard role="customer" userName={name} initials={initials} missions={dashboardMissions} notifications={dashboardNotifications} />;
}
