"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { missionRecurrences, missionTemplates } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function setRecurrenceStatus(formData: FormData) {
  const user = await requireAppUser("customer");
  const recurrenceId = String(formData.get("recurrenceId") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!UUID_PATTERN.test(recurrenceId) || (status !== "active" && status !== "paused" && status !== "ended")) return;
  await getDb().update(missionRecurrences).set({ status, updatedAt: new Date() }).where(and(eq(missionRecurrences.id, recurrenceId), eq(missionRecurrences.customerId, user.id)));
  revalidatePath("/dashboard/customer/saved");
}

export async function archiveMissionTemplate(formData: FormData) {
  const user = await requireAppUser("customer");
  const templateId = String(formData.get("templateId") ?? "");
  if (!UUID_PATTERN.test(templateId)) return;
  const db = getDb();
  const now = new Date();
  await db.batch([
    db.update(missionTemplates).set({ archivedAt: now, updatedAt: now }).where(and(eq(missionTemplates.id, templateId), eq(missionTemplates.customerId, user.id))),
    db.update(missionRecurrences).set({ status: "ended", updatedAt: now }).where(and(eq(missionRecurrences.templateId, templateId), eq(missionRecurrences.customerId, user.id))),
  ]);
  revalidatePath("/dashboard/customer/saved");
}
