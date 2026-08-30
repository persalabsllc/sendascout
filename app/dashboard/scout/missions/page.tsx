import Link from "next/link";
import { and, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { IconCamera, IconMapPin, IconRoute, IconClock } from "@tabler/icons-react";
import { ScoutDashboardShell } from "@/components/scout-dashboard-shell";
import { getDb } from "@/db";
import { missionBundles, missions, scoutProfiles } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";
import { isMissionEligibleForScout } from "@/lib/scout-matching";

export const metadata = { title: "Mission Board | Send a Scout", robots: { index: false, follow: false } };

export default async function ScoutMissionsPage() {
  const user = await requireAppUser("scout");
  const db = getDb();
  const [profile] = await db.select().from(scoutProfiles).where(eq(scoutProfiles.userId, user.id)).limit(1);
  const rows = await db.select().from(missions).where(and(isNull(missions.archivedAt), or(
    eq(missions.scoutId, user.id),
    and(eq(missions.status, "open"), or(
      isNull(missions.preferredScoutId),
      eq(missions.preferredScoutId, user.id),
      isNotNull(missions.preferredScoutBroadcastAt),
      lte(missions.preferredScoutExclusiveUntil, sql`now()`),
    )),
  ))).orderBy(desc(missions.createdAt));
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
  const eligible = rows.filter((mission) => {
    if (mission.bundleId && mission.bundleSequence !== bundleById.get(mission.bundleId)?.activeSequence) return false;
    if (mission.scoutId === user.id) return true;
    if (profile?.status !== "approved") return false;
    const legs = mission.bundleId ? legsByBundle.get(mission.bundleId) ?? [mission] : [mission];
    return legs.every((leg) => isMissionEligibleForScout(leg, profile));
  }).map((mission) => {
    const bundle = mission.bundleId ? bundleById.get(mission.bundleId) : null;
    return bundle ? { ...mission, title: bundle.title, scoutPayoutCents: bundle.scoutPayoutCents } : mission;
  });
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
