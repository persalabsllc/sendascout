import { eq } from "drizzle-orm";
import { IconCamera } from "@tabler/icons-react";
import { ScoutDashboardShell } from "@/components/scout-dashboard-shell";
import { ScoutPayoutAccount } from "@/components/scout-payout-account";
import { ScoutSettingsForm } from "@/components/scout-settings-form";
import { getDb } from "@/db";
import { scoutProfiles } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";
import { getStripeLivemode } from "@/lib/stripe";

export const metadata = { title: "Scout Settings | Send a Scout", robots: { index: false, follow: false } };

export default async function ScoutSettingsPage() {
  const user = await requireAppUser("scout");
  const [profile] = await getDb().select().from(scoutProfiles).where(eq(scoutProfiles.userId, user.id)).limit(1);
  if (!profile) return null;
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "Scout";
  const needsHeadshot = !profile.headshotPath;
  return <ScoutDashboardShell active="settings" name={name}><div className="dash-welcome simple-title"><div><span className="kicker">Scout profile</span><h1>{needsHeadshot ? "Finish your Scout application" : "Profile & mission preferences"}</h1><p>{needsHeadshot ? "Add your required headshot below. Your dashboard tracker shows any other remaining setup." : "Help customers recognize who is arriving, then choose the missions you want to see."}</p></div></div>{needsHeadshot && <div className="scout-banner required-profile-banner" role="alert"><span><IconCamera size={26} /></span><div><strong>Profile headshot required</strong><p>Your application is saved, but your Scout profile cannot become mission-ready until the photo below uploads successfully.</p></div><span className="status">Required</span></div>}<ScoutPayoutAccount status={profile.stripeConnectStatus} hasAccount={Boolean(profile.stripeAccountId)} livemodeMatches={profile.stripeAccountLivemode === getStripeLivemode()} canReceiveTransfers={Boolean(profile.stripeTransfersActive && profile.payoutsEnabled)} currentlyDue={profile.stripeRequirementsCurrentlyDue} pastDue={profile.stripeRequirementsPastDue} pendingVerification={profile.stripeRequirementsPendingVerification} futureDue={profile.stripeRequirementsFutureDue} disabledReason={profile.stripeDisabledReason} payoutScheduleConfigured={Boolean(profile.stripePayoutScheduleConfiguredAt)} /><section className="dash-section settings-section"><div className="dash-section-title"><div><h2>Public Scout profile</h2><p>Your first name, photo, completed mission count and rating appear only to customers whose mission you accept.</p></div></div><ScoutSettingsForm scoutId={user.id} headshotUrl={profile.headshotPath ? `/api/scout-headshot?scoutId=${encodeURIComponent(user.id)}` : null} initial={{ firstName: user.firstName ?? "", lastName: user.lastName ?? "", phone: user.phone ?? "", verificationConsent: Boolean(profile.verificationConsentedAt), homeZip: profile.homeZip ?? "", serviceRadiusMiles: profile.serviceRadiusMiles, vehicleType: profile.vehicleType ?? "", canSee: profile.canSee, canMove: profile.canMove, canMeet: profile.canMeet, emailNotificationsEnabled: user.emailNotificationsEnabled, smsNotificationsEnabled: user.smsNotificationsEnabled }} /></section></ScoutDashboardShell>;
}
