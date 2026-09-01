"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { scoutHandbookAcceptances, scoutProfiles } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";
import { alertScoutToOpenMissions } from "@/lib/notifications";
import { tryAutoApproveScout } from "@/lib/scout-auto-approval";
import { hasCurrentScoutHandbookAcceptance, SCOUT_HANDBOOK_VERSION } from "@/lib/scout-handbook";

export async function acceptScoutHandbook(formData: FormData) {
  const user = await requireAppUser("scout");
  if (user.role !== "scout") throw new Error("Only Scout accounts can acknowledge the Scout Handbook.");
  if (formData.get("handbookAcknowledgement") !== "accepted") {
    throw new Error("Review the Scout Handbook and check the acknowledgment before continuing.");
  }

  const db = getDb();
  const [profile] = await db.select({
    handbookVersion: scoutProfiles.handbookVersion,
    handbookAcceptedAt: scoutProfiles.handbookAcceptedAt,
  }).from(scoutProfiles).where(eq(scoutProfiles.userId, user.id)).limit(1);
  if (!profile) throw new Error("Complete your Scout profile before acknowledging the Scout Handbook.");
  if (hasCurrentScoutHandbookAcceptance(profile)) {
    await tryAutoApproveScout(user.id);
    redirect(safeScoutReturnPath(formData.get("next")));
  }

  const now = new Date();
  const requestHeaders = await headers();
  await db.batch([
    db.insert(scoutHandbookAcceptances).values({
      userId: user.id,
      handbookVersion: SCOUT_HANDBOOK_VERSION,
      source: "dashboard",
      userAgent: requestHeaders.get("user-agent")?.slice(0, 500) ?? null,
      acceptedAt: now,
    }).onConflictDoNothing(),
    db.update(scoutProfiles).set({
      handbookVersion: SCOUT_HANDBOOK_VERSION,
      handbookAcceptedAt: now,
      updatedAt: now,
    }).where(eq(scoutProfiles.userId, user.id)),
  ]);
  await tryAutoApproveScout(user.id);

  revalidatePath("/dashboard/scout");
  revalidatePath("/dashboard/scout/missions");
  revalidatePath("/dashboard/scout/handbook");
  revalidatePath("/dashboard/notifications");

  try {
    await alertScoutToOpenMissions(user.id);
  } catch (error) {
    console.error("Scout Handbook accepted, but existing mission alerts could not be refreshed.", error);
  }

  redirect(safeScoutReturnPath(formData.get("next")));
}

function safeScoutReturnPath(value: FormDataEntryValue | null) {
  if (typeof value !== "string") return "/dashboard/scout";
  if (value === "/dashboard/scout" || value.startsWith("/dashboard/scout/")) return value;
  if (/^\/dashboard\/missions\/[0-9a-f-]+$/i.test(value)) return value;
  return "/dashboard/scout";
}
