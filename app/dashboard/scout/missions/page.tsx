import Link from "next/link";
import { desc, eq, or } from "drizzle-orm";
import { IconCamera, IconMapPin, IconRoute, IconClock } from "@tabler/icons-react";
import { ScoutDashboardShell } from "@/components/scout-dashboard-shell";
import { getDb } from "@/db";
import { missions, scoutProfiles } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";

export const metadata = { title: "Mission Board | Send a Scout", robots: { index: false, follow: false } };

export default async function ScoutMissionsPage() {
  const user = await requireAppUser("scout");
  const db = getDb();
  const [profile] = await db.select().from(scoutProfiles).where(eq(scoutProfiles.userId, user.id)).limit(1);
  const rows = await db.select().from(missions).where(or(eq(missions.status, "open"), eq(missions.scoutId, user.id))).orderBy(desc(missions.createdAt));
  const eligible = rows.filter((mission) => mission.scoutId === user.id || (profile?.status === "approved" && (mission.type === "see" ? profile.canSee : mission.type === "move" ? profile.canMove : profile.canMeet)));
  const active = eligible.filter((mission) => mission.scoutId === user.id && !["completed", "cancelled", "disputed"].includes(mission.status));
  const open = eligible.filter((mission) => mission.status === "open" && !mission.scoutId);
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "Scout";
  return <ScoutDashboardShell active="missions" name={name}><PageTitle title="Mission board" text="Review active work and open opportunities in your service area." />
    <MissionSection title="Your active missions" empty="You do not have an active mission right now." rows={active} />
    <MissionSection title="Open missions" empty="There are no matching open missions right now." rows={open} />
  </ScoutDashboardShell>;
}

function PageTitle({ title, text }: { title: string; text: string }) { return <div className="dash-welcome simple-title"><div><span className="kicker">Scout command center</span><h1>{title}</h1><p>{text}</p></div></div>; }
function MissionSection({ title, empty, rows }: { title: string; empty: string; rows: (typeof missions.$inferSelect)[] }) {
  return <section className="dash-section"><div className="dash-section-title"><div><h2>{title}</h2><p>Every amount below is the Scout payout—not the customer price.</p></div></div>{rows.length ? <div className="mission-list scout-list">{rows.map((mission) => {
    const Icon = mission.type === "see" ? IconCamera : mission.type === "move" ? IconRoute : IconClock;
    return <Link className="mission-list-row" href={`/dashboard/missions/${mission.id}`} key={mission.id}><span className="list-icon"><Icon size={22} /></span><div className="list-main"><small>{mission.type === "see" ? "See It" : mission.type === "move" ? "Move It" : "Meet It"}</small><strong>{mission.title}</strong><span><IconMapPin size={14} /> {mission.city}, {mission.state} {mission.zip}</span></div><div className="payout"><small>Scout payout</small><strong>{money(mission.scoutPayoutCents)}</strong></div><span className="claim-button">{mission.status === "open" ? "Review" : label(mission.status)}</span></Link>;
  })}</div> : <div className="dashboard-empty"><p>{empty}</p></div>}</section>;
}
function money(cents: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100); }
function label(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
