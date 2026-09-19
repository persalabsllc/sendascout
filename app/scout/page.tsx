import { ScoutMissionContext } from "@/components/scout-mission-context";
import Link from "next/link";
import { IconArrowRight, IconBriefcase, IconShieldCheck } from "@tabler/icons-react";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { Brand } from "@/components/brand";
import { OnboardingForm } from "@/components/onboarding-form";
import { getDb } from "@/db";
import { scoutProfiles } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";

export default async function ScoutPage({ searchParams }: { searchParams: Promise<{ mission?: string }> }) {
  const requested = (await searchParams).mission;
  const mission = requested && /^[0-9a-f-]{36}$/i.test(requested) ? requested : undefined;
  const returnTo = mission ? `/scout?mission=${mission}` : "/scout";
  const { userId } = await auth();
  if (!userId) return <ScoutAccess mission={mission} />;
  const user = await requireAppUser("scout", returnTo);
  const [profile] = await getDb().select({ id: scoutProfiles.id, headshotPath: scoutProfiles.headshotPath }).from(scoutProfiles).where(eq(scoutProfiles.userId, user.id)).limit(1);
  if (mission && profile) return <div className="role-access-page"><Brand /><ScoutMissionContext missionId={mission} dashboard /><Link className="button" href={`/dashboard/missions/${mission}`}>Review mission and setup requirements</Link></div>;
  if (profile?.headshotPath) redirect("/dashboard/scout");
  if (profile) redirect("/dashboard/scout/settings");
  return <><div className="shell"><ScoutMissionContext missionId={mission} /></div><OnboardingForm mode="scout" /></>;
}

function ScoutAccess({ mission }: { mission?: string }) {
  const redirect = encodeURIComponent(mission ? `/scout?mission=${mission}` : "/scout");
  return <main className="role-access-page">
    <Brand /><ScoutMissionContext missionId={mission} />
    <section className="role-access-card">
      <span className="access-icon"><IconBriefcase size={31} /></span>
      <span className="kicker">Scout access</span>
      <h1>Earn locally. Work flexibly.</h1>
      <p>Existing Scouts can return to their mission dashboard. New Scouts can create an account and complete the application.</p>
      <div className="role-access-actions">
        <Link className="button" href={`/sign-in?portal=scout&redirect_url=${redirect}`}>Scout login <IconArrowRight size={18} /></Link>
        <Link className="button button-ghost" href={`/sign-up?redirect_url=${redirect}`}>Apply to become a Scout</Link>
      </div>
      <Link className="text-link" href="/missions">Browse available missions before signing up →</Link>
      <small><IconShieldCheck size={15} /> Existing Scouts do not need to apply again.</small>
    </section>
    <Link className="back-home-link" href="/">Back to Send a Scout</Link>
  </main>;
}
