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

export default async function ScoutPage() {
  const { userId } = await auth();
  if (!userId) return <ScoutAccess />;
  const user = await requireAppUser("scout");
  const [profile] = await getDb().select({ id: scoutProfiles.id }).from(scoutProfiles).where(eq(scoutProfiles.userId, user.id)).limit(1);
  if (profile) redirect("/dashboard/scout");
  return <OnboardingForm mode="scout" />;
}

function ScoutAccess() {
  return <main className="role-access-page">
    <Brand />
    <section className="role-access-card">
      <span className="access-icon"><IconBriefcase size={31} /></span>
      <span className="kicker">Scout access</span>
      <h1>Earn locally. Work flexibly.</h1>
      <p>Existing Scouts can return to their mission dashboard. New Scouts can create an account and complete the application.</p>
      <div className="role-access-actions">
        <Link className="button" href="/sign-in?redirect_url=/dashboard/scout">Scout login <IconArrowRight size={18} /></Link>
        <Link className="button button-ghost" href="/sign-up?redirect_url=/scout">Apply to become a Scout</Link>
      </div>
      <small><IconShieldCheck size={15} /> Existing Scouts do not need to apply again.</small>
    </section>
    <Link className="back-home-link" href="/">Back to Send a Scout</Link>
  </main>;
}
