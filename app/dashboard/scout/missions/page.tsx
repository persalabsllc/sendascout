import Link from "next/link";
import { and, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { IconCamera, IconMapPin, IconRoute, IconClock } from "@tabler/icons-react";
import { ScoutDashboardShell } from "@/components/scout-dashboard-shell";
import { ScoutPayoutRequiredBanner } from "@/components/scout-payout-required-banner";
import { getDb } from "@/db";
import { missionBundles, missions, scoutProfiles } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";
import { scoutMissionEligibility, type ScoutMissionEligibilityReason } from "@/lib/scout-matching";
import { scoutConnectReady } from "@/lib/stripe-connect";
import { getStripeLivemode } from "@/lib/stripe";

export const metadata = { title: "Mission Board | Send a Scout", robots: { index: false, follow: false } };

export default async function ScoutMissionsPage() {
  const user = await requireAppUser("scout");
  const db = getDb();
  const [profile] = await db.select().from(scoutProfiles).where(eq(scoutProfiles.userId, user.id)).limit(1);
  const stripeLivemode = getStripeLivemode();
  const payoutReady = Boolean(profile && scoutConnectReady(profile, stripeLivemode));
  const rows = await db.select().from(missions).where(and(isNull(missions.archivedAt), or(
    eq(missions.scoutId, user.id),
    and(eq(missions.status, "open"), eq(missions.paymentStatus, "paid"), or(
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
  const visibleRows = rows.filter((mission) => !mission.bundleId || (bundleById.get(mission.bundleId)?.paymentStatus === "paid" && mission.bundleSequence === bundleById.get(mission.bundleId)?.activeSequence));
  const hiddenReasons = new Set<ScoutMissionEligibilityReason>();
  const eligible = visibleRows.filter((mission) => {
    if (mission.scoutId === user.id) return true;
    if (profile?.status !== "approved" || !payoutReady) return false;
    const legs = mission.bundleId ? legsByBundle.get(mission.bundleId) ?? [mission] : [mission];
    const reasons = legs.map((leg) => scoutMissionEligibility(leg, profile)).filter((reason): reason is ScoutMissionEligibilityReason => reason !== null);
    reasons.forEach((reason) => hiddenReasons.add(reason));
    return reasons.length === 0;
  }).map((mission) => {
    const bundle = mission.bundleId ? bundleById.get(mission.bundleId) : null;
    return bundle ? { ...mission, title: bundle.title, scoutPayoutCents: bundle.scoutPayoutCents } : mission;
  });
  const active = eligible.filter((mission) => mission.scoutId === user.id && !["completed", "cancelled", "disputed"].includes(mission.status));
  const open = eligible.filter((mission) => mission.status === "open" && !mission.scoutId);
  const openCandidates = visibleRows.filter((mission) => mission.status === "open" && !mission.scoutId);
  const unmatchedOpenCount = profile?.status === "approved" && payoutReady ? Math.max(0, openCandidates.length - open.length) : 0;
  const openEmpty = profile?.status !== "approved"
    ? "Your application must be approved before open missions appear."
    : !payoutReady
      ? "Finish Stripe payout setup before open missions appear."
    : unmatchedOpenCount
      ? unmatchedMissionCopy(unmatchedOpenCount, hiddenReasons)
      : "There are no matching open missions right now.";
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "Scout";
  return <ScoutDashboardShell active="missions" name={name}><PageTitle title="Mission board" text="Review active work and open opportunities in your service area." />
    {!payoutReady && <ScoutPayoutRequiredBanner applicationApproved={profile?.status === "approved"} />}
    <MissionSection title="Your active missions" empty="You do not have an active mission right now." rows={active} />
    <MissionSection title="Open missions" empty={openEmpty} rows={open} emptyAction={unmatchedOpenCount ? { href: "/dashboard/scout/settings", label: "Review profile settings" } : undefined} />
  </ScoutDashboardShell>;
}

function PageTitle({ title, text }: { title: string; text: string }) { return <div className="dash-welcome simple-title"><div><span className="kicker">Scout command center</span><h1>{title}</h1><p>{text}</p></div></div>; }
function MissionSection({ title, empty, rows, emptyAction }: { title: string; empty: string; rows: (typeof missions.$inferSelect)[]; emptyAction?: { href: string; label: string } }) {
  return <section className="dash-section"><div className="dash-section-title"><div><h2>{title}</h2><p>Every amount below is the Scout payout—not the customer price.</p></div></div>{rows.length ? <div className="mission-list scout-list">{rows.map((mission) => {
    const Icon = mission.type === "see" ? IconCamera : mission.type === "move" ? IconRoute : IconClock;
    return <Link className="mission-list-row" href={`/dashboard/missions/${mission.id}`} key={mission.id}><span className="list-icon"><Icon size={22} /></span><div className="list-main"><small>{mission.type === "see" ? "See It" : mission.type === "move" ? "Move It" : "Meet It"}</small><strong>{mission.title}</strong><span><IconMapPin size={14} /> {mission.city}, {mission.state} {mission.zip}</span></div><div className="payout"><small>Scout payout</small><strong>{money(mission.scoutPayoutCents)}</strong></div><span className="claim-button">{mission.status === "open" ? "Review" : label(mission.status)}</span></Link>;
  })}</div> : <div className="dashboard-empty"><p>{empty}</p>{emptyAction && <Link className="button button-small button-ghost" href={emptyAction.href}>{emptyAction.label}</Link>}</div>}</section>;
}
function unmatchedMissionCopy(count: number, reasons: Set<ScoutMissionEligibilityReason>) {
  if (reasons.size === 1 && reasons.has("vehicle")) return count === 1
    ? "1 open mission is a larger-item Move It job. Those jobs require an SUV, pickup truck, or van in your Scout profile."
    : `${count} open missions are larger-item Move It jobs. Those jobs require an SUV, pickup truck, or van in your Scout profile.`;
  return count === 1
    ? "1 open mission is outside your current travel zone, mission types, or vehicle eligibility."
    : `${count} open missions are outside your current travel zone, mission types, or vehicle eligibility.`;
}
function money(cents: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100); }
function label(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
