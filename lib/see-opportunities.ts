import "server-only";
import { and, asc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { missions } from "@/db/schema";
import { getSeeTemplate, type SeeSnapshot } from "@/lib/see-it";
export async function seeOpportunities(id?: string) {
  const rows = await getDb().select({ id: missions.id, city: missions.city, state: missions.state, zip: missions.zip, payout: missions.scoutPayoutCents, deadline: missions.seeDeadlineAt, earliest: missions.seeEarliestVisitAt, cutoff: missions.seeAssignmentCutoffAt, timeZone: missions.timezone, key: missions.seeTemplateKey, snapshot: missions.seeTemplateSnapshot }).from(missions).where(and(
    eq(missions.status, "open"), eq(missions.paymentStatus, "paid"), isNull(missions.scoutId), isNull(missions.archivedAt), isNotNull(missions.seeTemplateKey), gt(missions.seeAssignmentCutoffAt, sql`now()`),
    or(isNull(missions.preferredScoutId), isNotNull(missions.preferredScoutBroadcastAt), sql`${missions.preferredScoutExclusiveUntil} <= now()`), id ? eq(missions.id,id) : undefined,
  )).orderBy(asc(missions.seeDeadlineAt)).limit(id ? 1 : 100);
  // This is a deliberate public allowlist. Never return customer instructions, address,
  // identifiers, contacts, coordinates, or customer-written questions here.
  return rows.flatMap(row => {
    const snapshot = row.snapshot as SeeSnapshot | null;
    const template = snapshot?.template ?? getSeeTemplate(row.key);
    if (!template) return [];
    return [{ id: row.id, city: row.city, state: row.state, zip: row.zip, payout: row.payout, deadline: row.deadline, earliest: row.earliest, cutoff: row.cutoff, timeZone: row.timeZone, template, additionalQuestions: snapshot?.configuration.extraQuestions.length ?? 0, access: snapshot?.configuration.access === "permission" ? "Permission-based access arranged by the customer" : "Publicly accessible exterior", hasVisitHours: Boolean(snapshot?.configuration.visitHours) }];
  });
}
export function seeDate(date: Date | null, timeZone: string) { return date ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone }).format(date) : "Pending"; }
