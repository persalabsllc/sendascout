"use server";

import { clerkClient } from "@clerk/nextjs/server";
import { del, head } from "@vercel/blob";
import { revalidatePath } from "next/cache";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { missions, scoutProfiles, users } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";

export type CustomerProfileInput = {
  firstName: string;
  lastName: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  zip: string;
  emailNotificationsEnabled: boolean;
  smsNotificationsEnabled: boolean;
};

export type ProfileResult = { ok: true } | { ok: false; error: string };
export type ScoutSettingsInput = { homeZip: string; serviceRadiusMiles: number; vehicleType: string; canSee: boolean; canMove: boolean; canMeet: boolean; emailNotificationsEnabled: boolean; smsNotificationsEnabled: boolean };

function required(value: string, label: string) {
  if (!value.trim()) throw new Error(`${label} is required.`);
}

export async function saveScoutSettings(input: ScoutSettingsInput): Promise<ProfileResult> {
  try {
    if (!/^\d{5}$/.test(input.homeZip.trim())) throw new Error("Enter a valid 5-digit home ZIP code.");
    if (![10, 25, 50, 75].includes(input.serviceRadiusMiles)) throw new Error("Choose a valid travel radius.");
    required(input.vehicleType, "Vehicle type");
    if (!input.canSee && !input.canMove && !input.canMeet) throw new Error("Choose at least one mission type.");
    const user = await requireAppUser("scout");
    await getDb().update(scoutProfiles).set({
      homeZip: input.homeZip.trim(),
      serviceRadiusMiles: input.serviceRadiusMiles,
      vehicleType: input.vehicleType.trim(),
      canSee: input.canSee,
      canMove: input.canMove,
      canMeet: input.canMeet,
      updatedAt: new Date(),
    }).where(eq(scoutProfiles.userId, user.id));
    if (input.smsNotificationsEnabled && !user.phone) throw new Error("Add a mobile number before enabling text alerts.");
    await getDb().update(users).set({
      emailNotificationsEnabled: input.emailNotificationsEnabled,
      smsNotificationsEnabled: input.smsNotificationsEnabled,
      smsConsentedAt: input.smsNotificationsEnabled ? user.smsConsentedAt ?? new Date() : user.smsConsentedAt,
      updatedAt: new Date(),
    }).where(eq(users.id, user.id));
    revalidatePath("/dashboard/scout");
    revalidatePath("/dashboard/scout/missions");
    revalidatePath("/dashboard/scout/settings");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "We could not save your Scout settings." };
  }
}

export async function saveCustomerProfile(input: CustomerProfileInput): Promise<ProfileResult> {
  try {
    required(input.firstName, "First name");
    required(input.lastName, "Last name");
    required(input.phone, "Mobile number");
    required(input.addressLine1, "Street address");
    required(input.city, "City");
    required(input.state, "State");
    required(input.zip, "ZIP code");

    const phoneDigits = input.phone.replace(/\D/g, "");
    if (phoneDigits.length < 10) throw new Error("Enter a valid mobile number.");
    if (!/^[A-Za-z]{2}$/.test(input.state.trim())) throw new Error("Enter a two-letter state abbreviation.");
    if (!/^\d{5}(?:-\d{4})?$/.test(input.zip.trim())) throw new Error("Enter a valid ZIP code.");

    const user = await requireAppUser("customer");
    const firstName = input.firstName.trim();
    const lastName = input.lastName.trim();

    await getDb()
      .update(users)
      .set({
        firstName,
        lastName,
        phone: input.phone.trim(),
        addressLine1: input.addressLine1.trim(),
        addressLine2: input.addressLine2.trim() || null,
        city: input.city.trim(),
        state: input.state.trim().toUpperCase(),
        zip: input.zip.trim(),
        profileCompletedAt: new Date(),
        emailNotificationsEnabled: input.emailNotificationsEnabled,
        smsNotificationsEnabled: input.smsNotificationsEnabled,
        smsConsentedAt: input.smsNotificationsEnabled ? user.smsConsentedAt ?? new Date() : user.smsConsentedAt,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    try {
      const clerk = await clerkClient();
      await clerk.users.updateUser(user.clerkUserId, { firstName, lastName });
    } catch (error) {
      console.warn("Customer profile saved, but Clerk name sync failed", error);
    }

    revalidatePath("/dashboard/customer");
    revalidatePath("/dashboard/customer/profile");
    revalidatePath("/request");
    return { ok: true };
  } catch (error) {
    console.error("Customer profile update failed", error);
    return { ok: false, error: error instanceof Error ? error.message : "We could not save your profile." };
  }
}

export async function saveScoutHeadshot(pathname: string): Promise<ProfileResult> {
  let cleanupPath: string | null = null;
  try {
    const user = await requireAppUser("scout");
    if (!pathname.startsWith(`scout-headshots/${user.id}/`) || pathname.includes("..")) throw new Error("That profile photo could not be verified.");
    const activeMissionStatuses = ["claimed", "en_route", "onsite", "en_route_pickup", "at_pickup", "en_route_dropoff", "at_dropoff", "submitted", "disputed"] as const;
    const [activeMission] = await getDb().select({ id: missions.id }).from(missions).where(and(
      eq(missions.scoutId, user.id),
      inArray(missions.status, activeMissionStatuses),
      isNull(missions.archivedAt),
    )).limit(1);
    if (activeMission) throw new Error("Finish or resolve your active mission before changing the verified photo customers rely on.");
    const metadata = await head(pathname);
    if (
      metadata.pathname !== pathname
      || !["image/jpeg", "image/png", "image/webp"].includes(metadata.contentType)
      || metadata.size <= 0
      || metadata.size > 5 * 1024 * 1024
    ) throw new Error("That profile photo is missing or has an unsupported format.");
    const db = getDb();
    const [existing] = await db.select({
      headshotPath: scoutProfiles.headshotPath,
      identityCheck: scoutProfiles.identityCheck,
      status: scoutProfiles.status,
    }).from(scoutProfiles).where(eq(scoutProfiles.userId, user.id)).limit(1);
    if (!existing || existing.status === "rejected") throw new Error("Your Scout profile is not eligible for photo uploads.");
    cleanupPath = existing.headshotPath === pathname ? null : pathname;
    const needsIdentityReview = existing.identityCheck === "clear" || existing.status === "approved";
    const lockProfile = db.update(scoutProfiles).set({
      updatedAt: sql`${scoutProfiles.updatedAt}`,
    }).where(and(
      eq(scoutProfiles.userId, user.id),
      eq(scoutProfiles.status, existing.status),
      eq(scoutProfiles.identityCheck, existing.identityCheck),
      sql`${scoutProfiles.headshotPath} IS NOT DISTINCT FROM ${existing.headshotPath}`,
    )).returning({ id: scoutProfiles.id });
    const savePhoto = db.update(scoutProfiles).set({
      headshotPath: pathname,
      identityCheck: needsIdentityReview ? "review" : existing.identityCheck,
      identityVerifiedAt: needsIdentityReview ? null : undefined,
      identityVerifiedBy: needsIdentityReview ? null : undefined,
      status: existing.status === "approved" ? "review" : existing.status,
      approvedAt: existing.status === "approved" ? null : undefined,
      updatedAt: new Date(),
    }).where(and(
      eq(scoutProfiles.userId, user.id),
      eq(scoutProfiles.status, existing.status),
      sql`NOT EXISTS (
        SELECT 1 FROM missions AS active_mission
        WHERE active_mission.scout_id = ${user.id}
          AND active_mission.status IN ('claimed', 'en_route', 'onsite', 'en_route_pickup', 'at_pickup', 'en_route_dropoff', 'at_dropoff', 'submitted', 'disputed')
          AND active_mission.archived_at IS NULL
      )`,
    )).returning({ id: scoutProfiles.id });
    const [lockedRows, updatedRows] = await db.batch([lockProfile, savePhoto]);
    if (!lockedRows[0] || !updatedRows[0]) throw new Error("Your Scout profile or active mission changed in another window. Refresh before trying again.");
    cleanupPath = null;
    if (existing.headshotPath && existing.headshotPath !== pathname) {
      const [retainedMission] = await db.select({ id: missions.id }).from(missions)
        .where(eq(missions.scoutHeadshotPathSnapshot, existing.headshotPath)).limit(1);
      if (!retainedMission) {
        try {
          await del(existing.headshotPath);
        } catch (error) {
          console.warn("Old Scout headshot could not be removed", error);
        }
      }
    }
    revalidatePath("/dashboard/scout");
    revalidatePath("/dashboard/scout/settings");
    revalidatePath("/scout");
    revalidatePath("/dashboard/missions/[id]", "page");
    revalidatePath("/control-room");
    return { ok: true };
  } catch (error) {
    if (cleanupPath) {
      try {
        await del(cleanupPath);
      } catch (cleanupError) {
        console.warn("Unattached Scout headshot could not be removed", cleanupError);
      }
    }
    return { ok: false, error: error instanceof Error ? error.message : "We could not save your profile photo." };
  }
}
