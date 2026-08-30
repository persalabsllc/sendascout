import Link from "next/link";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { IconArrowRight, IconCalendarRepeat, IconPlayerPause, IconPlayerPlay, IconTemplate } from "@tabler/icons-react";
import { setRecurrenceStatus } from "@/app/actions/customer-features";
import { ArchiveTemplateForm } from "@/components/archive-template-form";
import { CustomerDashboardShell } from "@/components/customer-dashboard-shell";
import { getDb } from "@/db";
import { missionRecurrences, missions, missionTemplates } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";
import { formatDateTime } from "@/lib/time";
import { missionTimeZoneLabel } from "@/lib/us-time-zones";

export const metadata = { title: "Saved & Recurring | Send a Scout", robots: { index: false, follow: false } };

export default async function SavedAndRecurringPage() {
  const user = await requireAppUser("customer");
  const db = getDb();
  const [templates, recurrences, publishedOccurrenceRows] = await Promise.all([
    db.select().from(missionTemplates).where(and(eq(missionTemplates.customerId, user.id), isNull(missionTemplates.archivedAt))).orderBy(desc(missionTemplates.updatedAt)),
    db.select({ recurrence: missionRecurrences, templateName: missionTemplates.name, templateType: missionTemplates.type })
      .from(missionRecurrences)
      .innerJoin(missionTemplates, eq(missionRecurrences.templateId, missionTemplates.id))
      .where(and(eq(missionRecurrences.customerId, user.id), isNull(missionTemplates.archivedAt)))
      .orderBy(desc(missionRecurrences.createdAt)),
    db.select({ recurrenceId: missions.recurrenceId, occurrenceAt: missions.recurrenceOccurrenceAt })
      .from(missions)
      .where(and(
        eq(missions.customerId, user.id),
        isNotNull(missions.recurrenceId),
        isNotNull(missions.recurrenceOccurrenceAt),
      )),
  ]);
  const publishedOccurrences = new Set(publishedOccurrenceRows.flatMap((row) => row.recurrenceId && row.occurrenceAt
    ? [occurrenceKey(row.recurrenceId, row.occurrenceAt)]
    : []));
  const schedules = recurrences.map((item) => ({
    ...item,
    bookableOccurrence: nextBookableOccurrence(item.recurrence, publishedOccurrences),
  }));
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "Customer";
  return <CustomerDashboardShell active="saved" name={name}>
    <div className="dash-welcome simple-title"><div><span className="kicker">Faster rebooking</span><h1>Saved &amp; recurring</h1><p>Reusable mission details and customer-controlled schedules live here.</p></div><Link className="button" href="/request">New mission <IconArrowRight size={18} /></Link></div>
    <section className="dash-section"><div className="dash-section-title"><div><h2>Recurring schedules</h2><p>Schedules remind you what is due; they never publish or charge an unpaid mission automatically.</p></div></div>{schedules.length ? <div className="saved-feature-list">{schedules.map(({ recurrence, templateName, templateType, bookableOccurrence }) => <article key={recurrence.id}><span className="list-icon"><IconCalendarRepeat size={22} /></span><div><small>{missionLabel(templateType)} · {recurrenceLabel(recurrence.recurrenceRule)}</small><strong>{templateName}</strong><p>{bookableOccurrence ? `Next customer review: ${formatDateTime(bookableOccurrence, recurrence.timezone)}` : "Current scheduled occurrence already booked"} · {missionTimeZoneLabel(recurrence.timezone)}</p></div><span className={`status ${recurrence.status !== "active" ? "muted-status" : ""}`}>{titleCase(recurrence.status)}</span><div className="saved-feature-actions">{bookableOccurrence ? <Link href={`/request?template=${recurrence.templateId}&recurrence=${recurrence.id}&occurrence=${encodeURIComponent(bookableOccurrence.toISOString())}`}>Book next <IconArrowRight size={15} /></Link> : <span className="muted-action">Already booked</span>}{recurrence.status !== "ended" && <form action={setRecurrenceStatus}><input type="hidden" name="recurrenceId" value={recurrence.id} /><input type="hidden" name="status" value={recurrence.status === "active" ? "paused" : "active"} /><button type="submit">{recurrence.status === "active" ? <><IconPlayerPause size={15} /> Pause</> : <><IconPlayerPlay size={15} /> Resume</>}</button></form>}</div></article>)}</div> : <div className="dashboard-empty"><IconCalendarRepeat size={30} /><h3>No recurring schedules yet</h3><p>Choose weekly, every two weeks or monthly in a mission’s Options step.</p></div>}</section>
    <section className="dash-section"><div className="dash-section-title"><div><h2>Mission templates</h2><p>Book again without retyping locations and instructions.</p></div></div>{templates.length ? <div className="saved-feature-list">{templates.map((template) => <article key={template.id}><span className="list-icon"><IconTemplate size={22} /></span><div><small>{missionLabel(template.type)}</small><strong>{template.name}</strong><p>Last used {template.lastUsedAt ? template.lastUsedAt.toLocaleDateString() : "not yet"}</p></div><div className="saved-feature-actions"><Link href={`/request?template=${template.id}`}>Use template <IconArrowRight size={15} /></Link><ArchiveTemplateForm templateId={template.id} /></div></article>)}</div> : <div className="dashboard-empty"><IconTemplate size={30} /><h3>No saved templates</h3><p>Turn on “Save as a reusable template” while creating any mission.</p><Link className="button button-small" href="/request">Create a mission</Link></div>}</section>
  </CustomerDashboardShell>;
}

function missionLabel(type: "see" | "move" | "meet") { return type === "see" ? "See It" : type === "move" ? "Move It" : "Meet It"; }
function recurrenceLabel(rule: string) { return rule.includes("MONTHLY") ? "Monthly" : rule.includes("INTERVAL=2") ? "Every 2 weeks" : "Weekly"; }
function titleCase(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function occurrenceKey(recurrenceId: string, occurrenceAt: Date) { return `${recurrenceId}:${occurrenceAt.toISOString()}`; }
function nextBookableOccurrence(recurrence: { id: string; lastRunAt: Date | null; nextRunAt: Date | null }, publishedOccurrences: Set<string>) {
  const candidates = [recurrence.lastRunAt, recurrence.nextRunAt].filter((candidate): candidate is Date => Boolean(candidate));
  return candidates.find((candidate, index, all) => (
    all.findIndex((item) => item.getTime() === candidate.getTime()) === index
    && !publishedOccurrences.has(occurrenceKey(recurrence.id, candidate))
  )) ?? null;
}
