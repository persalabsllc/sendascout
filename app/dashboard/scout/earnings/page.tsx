import Link from "next/link";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { IconArrowRight, IconCircleCheck, IconClock, IconWallet } from "@tabler/icons-react";
import { ScoutPayoutAccount } from "@/components/scout-payout-account";
import { ScoutDashboardShell } from "@/components/scout-dashboard-shell";
import { getDb } from "@/db";
import { missionBundles, missions, paymentTransfers, scoutProfiles, stripePayouts } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";
import { getStripeLivemode } from "@/lib/stripe";

export const metadata = { title: "Scout Earnings | Send a Scout", robots: { index: false, follow: false } };

export default async function ScoutEarningsPage() {
  const user = await requireAppUser("scout");
  const db = getDb();
  const [profile] = await db.select().from(scoutProfiles).where(eq(scoutProfiles.userId, user.id)).limit(1);
  const [rows, transferRows, payoutRows] = await Promise.all([
    db.select().from(missions).where(and(eq(missions.scoutId, user.id), isNull(missions.archivedAt))).orderBy(desc(missions.completedAt), desc(missions.createdAt)),
    db.select().from(paymentTransfers).where(eq(paymentTransfers.scoutId, user.id)).orderBy(desc(paymentTransfers.createdAt)),
    profile ? db.select().from(stripePayouts).where(eq(stripePayouts.scoutProfileId, profile.id)).orderBy(desc(stripePayouts.createdAt)) : Promise.resolve([]),
  ]);
  const bundleIds = [...new Set(rows.flatMap((mission) => mission.bundleId ? [mission.bundleId] : []))];
  const bundleRows = bundleIds.length ? await db.select().from(missionBundles).where(inArray(missionBundles.id, bundleIds)) : [];
  const bundleById = new Map(bundleRows.map((bundle) => [bundle.id, bundle]));
  const displayRows = rows.filter((mission) => !mission.bundleId || mission.bundleSequence === bundleById.get(mission.bundleId)?.activeSequence).map((mission) => {
    const bundle = mission.bundleId ? bundleById.get(mission.bundleId) : null;
    return bundle ? {
      ...mission,
      title: bundle.title,
      status: bundle.status,
      scoutPayoutCents: bundle.scoutPayoutCents,
      paymentStatus: bundle.paymentStatus,
      completedAt: bundle.completedAt,
    } : mission;
  });
  const completed = displayRows.filter((mission) => mission.status === "completed");
  const submitted = displayRows.filter((mission) => mission.status === "submitted");
  const earned = completed.reduce((sum, mission) => sum + mission.scoutPayoutCents, 0);
  const missionTransferRows = transferRows.filter((transfer) => transfer.kind !== "tip");
  const released = missionTransferRows.reduce((sum, transfer) => transfer.status === "succeeded" || transfer.status === "partially_reversed" || transfer.status === "reversed"
    ? sum + transfer.amountCents - transfer.reversedAmountCents
    : sum, 0);
  const submittedExpected = submitted.reduce((sum, mission) => sum + mission.scoutPayoutCents, 0);
  const pending = Math.max(0, earned - released) + submittedExpected;
  const bankPaid = payoutRows.filter((payout) => payout.status === "paid").reduce((sum, payout) => sum + payout.amountCents, 0);
  const payoutModeMatches = Boolean(profile && profile.stripeAccountLivemode === getStripeLivemode());
  const releasedByMission = new Map<string, number>();
  const releasedByBundle = new Map<string, number>();
  for (const transfer of missionTransferRows) {
    if (!["succeeded", "partially_reversed", "reversed"].includes(transfer.status)) continue;
    const amount = transfer.amountCents - transfer.reversedAmountCents;
    releasedByMission.set(transfer.missionId, (releasedByMission.get(transfer.missionId) ?? 0) + amount);
    if (transfer.bundleId) releasedByBundle.set(transfer.bundleId, (releasedByBundle.get(transfer.bundleId) ?? 0) + amount);
  }
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "Scout";
  return <ScoutDashboardShell active="earnings" name={name}><div className="dash-welcome simple-title"><div><span className="kicker">Scout payouts</span><h1>Earnings</h1><p>Your completed work, pending payouts, and payment readiness.</p></div></div>
    {profile && <ScoutPayoutAccount status={profile.stripeConnectStatus} hasAccount={Boolean(profile.stripeAccountId)} livemodeMatches={payoutModeMatches} canReceiveTransfers={Boolean(profile.stripeTransfersActive && profile.payoutsEnabled)} currentlyDue={profile.stripeRequirementsCurrentlyDue} pastDue={profile.stripeRequirementsPastDue} pendingVerification={profile.stripeRequirementsPendingVerification} futureDue={profile.stripeRequirementsFutureDue} disabledReason={profile.stripeDisabledReason} payoutScheduleConfigured={Boolean(profile.stripePayoutScheduleConfiguredAt)} />}
    <div className="stat-grid"><Stat icon={<IconCircleCheck size={22} />} label="Completed earnings" value={money(earned)} note={`${completed.length} completed mission${completed.length === 1 ? "" : "s"}`} /><Stat icon={<IconClock size={22} />} label="Awaiting release" value={money(pending)} note="Released after mission completion and payment checks" /><Stat icon={<IconWallet size={22} />} label="Bank payouts" value={money(bankPaid)} note={profile?.payoutsEnabled && payoutModeMatches ? "Tracked from Stripe payout events" : "Finish Stripe payout setup"} /></div>
    <section className="dash-section"><div className="dash-section-title"><div><h2>Completed mission history</h2><p>“Released” means the earnings reached your Stripe balance; Stripe then pays available funds on the configured schedule.</p></div></div>{completed.length ? <div className="mission-list">{completed.map((mission) => {
      const releasedCents = mission.bundleId ? releasedByBundle.get(mission.bundleId) ?? 0 : releasedByMission.get(mission.id) ?? 0;
      return <Link className="mission-list-row" href={`/dashboard/missions/${mission.id}`} key={mission.id}><span className="list-icon"><IconCircleCheck size={21} /></span><div className="list-main"><small>Completed {mission.completedAt?.toLocaleDateString() ?? ""}</small><strong>{mission.title}</strong><span>{mission.bundleId ? "Multi-part mission" : mission.type === "see" ? "See It" : mission.type === "move" ? "Move It" : "Meet It"}</span></div><div className="payout"><small>{releasedCents >= mission.scoutPayoutCents ? "Released to Stripe" : releasedCents > 0 ? "Partially released" : "Pending release"}</small><strong>{money(mission.scoutPayoutCents)}</strong></div><IconArrowRight className="list-arrow" size={18} /></Link>;
    })}</div> : <div className="dashboard-empty"><p>Completed missions will appear here with their Scout payout.</p></div>}</section>
  </ScoutDashboardShell>;
}

function Stat({ icon, label, value, note }: { icon: React.ReactNode; label: string; value: string; note: string }) { return <article className="stat-card"><span>{icon}</span><div><small>{label}</small><strong>{value}</strong><p>{note}</p></div></article>; }
function money(cents: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100); }
