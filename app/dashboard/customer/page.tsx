import { desc, eq } from "drizzle-orm";
import { Dashboard, type DashboardMission } from "@/components/dashboard";
import { getDb } from "@/db";
import { missions } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";
import { redirect } from "next/navigation";

export const metadata = { title: "Customer Dashboard | Send a Scout", robots: { index: false, follow: false } };

export default async function CustomerDashboard() {
  const user = await requireAppUser("customer");
  if (!user.profileCompletedAt) redirect("/dashboard/customer/profile?next=/dashboard/customer");
  const rows = await getDb().select().from(missions).where(eq(missions.customerId, user.id)).orderBy(desc(missions.createdAt));
  const dashboardMissions: DashboardMission[] = rows.map((mission) => ({
    id: mission.id, type: mission.type, title: mission.title,
    place: `${mission.city}, ${mission.state} ${mission.zip}`,
    status: mission.status,
    time: mission.scheduledFor ? mission.scheduledFor.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "ASAP",
  }));
  const name = user.firstName || "";
  const initials = `${user.firstName?.[0] ?? ""}${user.lastName?.[0] ?? ""}`.toUpperCase() || "SA";
  return <Dashboard role="customer" userName={name} initials={initials} missions={dashboardMissions} />;
}
