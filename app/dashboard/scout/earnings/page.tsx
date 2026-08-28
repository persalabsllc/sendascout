import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { IconArrowRight, IconCircleCheck, IconClock, IconWallet } from "@tabler/icons-react";
import { ScoutDashboardShell } from "@/components/scout-dashboard-shell";
import { getDb } from "@/db";
import { missions, scoutProfiles } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";

export const metadata = { title: "Scout Earnings | Send a Scout", robots: { index: false, follow: false } };

export default async function ScoutEarningsPage() {
  const user = await requireAppUser("scout");
  const db = getDb();
  const [profile] = await db.select().from(scoutProfiles).where(eq(scoutProfiles.userId, user.id)).limit(1);
  const rows = await db.select().from(missions).where(eq(missions.scoutId, user.id)).orderBy(desc(missions.completedAt), desc(missions.createdAt));
  const completed = rows.filter((mission) => mission.status === "completed");
  const submitted = rows.filter((mission) => mission.status === "submitted");
  const earned = completed.reduce((sum, mission) => sum + mission.scoutPayoutCents, 0);
  const pending = [...completed.filter((mission) => mission.paymentStatus !== "paid"), ...submitted].reduce((sum, mission) => sum + mission.scoutPayoutCents, 0);
  const paid = completed.filter((mission) => mission.paymentStatus === "paid").reduce((sum, mission) => sum + mission.scoutPayoutCents, 0);
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "Scout";
  return <ScoutDashboardShell active="earnings" name={name}><div className="dash-welcome simple-title"><div><span className="kicker">Scout payouts</span><h1>Earnings</h1><p>Your completed work, pending payouts, and payment readiness.</p></div></div>
    <div className="stat-grid"><Stat icon={<IconCircleCheck size={22} />} label="Completed earnings" value={money(earned)} note={`${completed.length} completed mission${completed.length === 1 ? "" : "s"}`} /><Stat icon={<IconClock size={22} />} label="Pending payout" value={money(pending)} note="Held until payout processing is active" /><Stat icon={<IconWallet size={22} />} label="Paid" value={money(paid)} note={profile?.payoutsEnabled ? "Payout account enabled" : "Payout onboarding coming before launch"} /></div>
    <section className="dash-section"><div className="dash-section-title"><div><h2>Completed mission history</h2><p>The Scout payout shown here is your earnings amount.</p></div></div>{completed.length ? <div className="mission-list">{completed.map((mission) => <Link className="mission-list-row" href={`/dashboard/missions/${mission.id}`} key={mission.id}><span className="list-icon"><IconCircleCheck size={21} /></span><div className="list-main"><small>Completed {mission.completedAt?.toLocaleDateString() ?? ""}</small><strong>{mission.title}</strong><span>{mission.type === "see" ? "See It" : mission.type === "move" ? "Move It" : "Meet It"}</span></div><div className="payout"><small>{mission.paymentStatus === "paid" ? "Paid" : "Pending payout"}</small><strong>{money(mission.scoutPayoutCents)}</strong></div><IconArrowRight className="list-arrow" size={18} /></Link>)}</div> : <div className="dashboard-empty"><p>Completed missions will appear here with their Scout payout.</p></div>}</section>
  </ScoutDashboardShell>;
}

function Stat({ icon, label, value, note }: { icon: React.ReactNode; label: string; value: string; note: string }) { return <article className="stat-card"><span>{icon}</span><div><small>{label}</small><strong>{value}</strong><p>{note}</p></div></article>; }
function money(cents: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100); }
