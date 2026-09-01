import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { IconBook2, IconCircleCheck } from "@tabler/icons-react";
import { acceptScoutHandbook } from "@/app/actions/scout-handbook";
import { ScoutDashboardShell } from "@/components/scout-dashboard-shell";
import { ScoutHandbookContent } from "@/components/scout-handbook-content";
import { getDb } from "@/db";
import { scoutProfiles } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";
import {
  hasCurrentScoutHandbookAcceptance,
  SCOUT_HANDBOOK_ACKNOWLEDGEMENT,
  SCOUT_HANDBOOK_EFFECTIVE_DATE,
  SCOUT_HANDBOOK_VERSION,
} from "@/lib/scout-handbook";

export const metadata = { title: "Scout Handbook | Send a Scout", robots: { index: false, follow: false } };

export default async function ScoutHandbookPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const user = await requireAppUser("scout");
  if (user.role !== "scout") redirect("/dashboard/customer");

  const [profile] = await getDb().select().from(scoutProfiles).where(eq(scoutProfiles.userId, user.id)).limit(1);
  if (!profile) redirect("/scout");

  const accepted = hasCurrentScoutHandbookAcceptance(profile);
  const { next: rawNext } = await searchParams;
  const next = Array.isArray(rawNext) ? rawNext[0] : rawNext;
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "Scout";

  return <ScoutDashboardShell active="handbook" name={name}>
    <div className="dash-welcome simple-title"><div><span className="kicker">Scout standards</span><h1>Scout Handbook</h1><p>Your practical guide to safe, respectful, and professional missions.</p></div></div>

    {accepted
      ? <div className="scout-banner"><span><IconCircleCheck size={26} /></span><div><strong>You acknowledged the current handbook</strong><p>Version {SCOUT_HANDBOOK_VERSION} · effective {SCOUT_HANDBOOK_EFFECTIVE_DATE} · acknowledged {formatAcceptanceDate(profile.handbookAcceptedAt)}</p></div><span className="status">Current</span></div>
      : <div className="handbook-required-card" role="status"><span><IconBook2 size={25} /></span><div><strong>{profile.handbookVersion ? "The Scout Handbook has been updated" : "Handbook review is required"}</strong><p>You may browse open missions, but you must read and acknowledge the current version before claiming one. Any mission already assigned to you remains accessible.</p></div></div>}

    {accepted
      ? <ScoutHandbookContent />
      : <section className="handbook-reader-card" aria-label="Required Scout Handbook review">
        <div className="handbook-reader-scroll" tabIndex={0}><ScoutHandbookContent variant="reader" /></div>
        <form action={acceptScoutHandbook} className="handbook-acceptance-form">
          {next && <input name="next" type="hidden" value={next} />}
          <label className="handbook-acceptance-check">
            <input name="handbookAcknowledgement" required type="checkbox" value="accepted" />
            <span>{SCOUT_HANDBOOK_ACKNOWLEDGEMENT}</span>
          </label>
          <div className="handbook-acceptance-actions">
            <span>Your acknowledgment is recorded with the handbook version and your account.</span>
            <button className="button" type="submit">Acknowledge handbook</button>
          </div>
        </form>
      </section>}
  </ScoutDashboardShell>;
}

function formatAcceptanceDate(value: Date | null) {
  if (!value) return "date unavailable";
  return value.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}
