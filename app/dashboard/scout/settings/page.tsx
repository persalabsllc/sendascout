import { eq } from "drizzle-orm";
import { ScoutDashboardShell } from "@/components/scout-dashboard-shell";
import { ScoutSettingsForm } from "@/components/scout-settings-form";
import { getDb } from "@/db";
import { scoutProfiles } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";

export const metadata = { title: "Scout Settings | Send a Scout", robots: { index: false, follow: false } };

export default async function ScoutSettingsPage() {
  const user = await requireAppUser("scout");
  const [profile] = await getDb().select().from(scoutProfiles).where(eq(scoutProfiles.userId, user.id)).limit(1);
  if (!profile) return null;
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "Scout";
  return <ScoutDashboardShell active="settings" name={name}><div className="dash-welcome simple-title"><div><span className="kicker">Scout profile</span><h1>Mission preferences</h1><p>Control which work you see, how far you travel, and what vehicle you use.</p></div></div><section className="dash-section settings-section"><div className="dash-section-title"><div><h2>Service area and vehicle</h2><p>These settings are used when matching you with new missions.</p></div></div><ScoutSettingsForm initial={{ homeZip: profile.homeZip ?? "", serviceRadiusMiles: profile.serviceRadiusMiles, vehicleType: profile.vehicleType ?? "", canSee: profile.canSee, canMove: profile.canMove, canMeet: profile.canMeet }} /></section></ScoutDashboardShell>;
}
