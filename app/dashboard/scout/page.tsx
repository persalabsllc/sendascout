import { and, desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { Dashboard, type DashboardMission } from "@/components/dashboard";
import { getDb } from "@/db";
import { missions, scoutProfiles } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";

export const metadata = { title: "Scout Dashboard | Send a Scout", robots: { index: false, follow: false } };

export default async function ScoutDashboard() {
  const user = await requireAppUser("scout");
  const db = getDb();
  const [profile] = await db.select().from(scoutProfiles).where(eq(scoutProfiles.userId, user.id)).limit(1);
  if (!profile) redirect("/scout");
  const rows = await db.select().from(missions).where(and(eq(missions.status, "open"))).orderBy(desc(missions.createdAt));
  const dashboardMissions: DashboardMission[] = rows.map((mission) => ({
    id: mission.id, type: mission.type, title: mission.title,
    place: `${mission.city}, ${mission.state} ${mission.zip}`,
    status: mission.status, time: mission.scheduledFor ? mission.scheduledFor.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "ASAP",
    payoutCents: mission.scoutPayoutCents,
  }));
  const name = user.firstName || "Scout";
  const initials = `${user.firstName?.[0] ?? ""}${user.lastName?.[0] ?? ""}`.toUpperCase() || "SA";
  return <Dashboard role="scout" userName={name} initials={initials} missions={dashboardMissions} profileStatus={profile.status} />;
}
