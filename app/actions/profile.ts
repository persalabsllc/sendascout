"use server";

import { clerkClient } from "@clerk/nextjs/server";
import { del, get } from "@vercel/blob";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { missions, scoutProfiles, users } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";
import { tryAutoApproveScout } from "@/lib/scout-auto-approval";
import { validateScoutHeadshotBytes } from "@/lib/scout-headshot";
import { SCOUT_HEADSHOT_MAX_BYTES } from "@/lib/scout-headshot-policy";
import { sendScoutOnboardingWelcome } from "@/lib/scout-onboarding-reminders";

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
export type ScoutSettingsInput = {
  firstName: string;
  lastName: string;
  phone: string;
  verificationConsent: boolean;
  homeZip: string;
  serviceRadiusMiles: number;
  vehicleType: string;
  canSee: boolean;
  canMove: boolean;
  canMeet: boolean;
  emailNotificationsEnabled: boolean;
  smsNotificationsEnabled: boolean;
};

function required(value: string, label: string) {
  if (!value.trim()) throw new Error(`${label} is required.`);
}

async function deleteScoutHeadshotIfUnreferenced(pathname: string) {
  const db = getDb();
  const [[currentProfile], [retainedMission]] = await Promise.all([
    db.select({ id: scoutProfiles.id }).from(scoutProfiles).where(eq(scoutProfiles.headshotPath, pathname)).limit(1),
    db.select({ id: missions.id }).from(missions).where(eq(missions.scoutHeadshotPathSnapshot, pathname)).limit(1),
  ]);
  if (currentProfile || retainedMission) return false;
  await del(pathname);
  return true;
}

export async function saveScoutSettings(input: ScoutSettingsInput): Promise<ProfileResult> {
  try {
    required(input.firstName, "First name");
    required(input.lastName, "Last name");
    const phoneDigits = input.phone.replace(/\D/g, "");
    if (phoneDigits.length < 10) throw new Error("Enter a valid mobile number.");
    if (!input.verificationConsent) throw new Error("Confirm Stripe identity and payout verification to finish your Scout profile.");
    if (!/^\d{5}$/.test(input.homeZip.trim())) throw new Error("Enter a valid 5-digit home ZIP code.");
    if (![10, 25, 50, 75].includes(input.serviceRadiusMiles)) throw new Error("Choose a valid travel radius.");
    required(input.vehicleType, "Vehicle type");
    if (!input.canSee && !input.canMove && !input.canMeet) throw new Error("Choose at least one mission type.");
    const user = await requireAppUser("scout");
    if (user.role !== "scout" || user.status !== "active") throw new Error("Only an active Scout account can update Scout settings.");
    const firstName = input.firstName.trim();
    const lastName = input.lastName.trim();
    const now = new Date();
    const db = getDb();
    const [profileRows, userRows] = await db.batch([
      db.update(scoutProfiles).set({
        homeZip: input.homeZip.trim(),
        serviceRadiusMiles: input.serviceRadiusMiles,
        vehicleType: input.vehicleType.trim(),
        canSee: input.canSee,
        canMove: input.canMove,
        canMeet: input.canMeet,
        verificationConsentedAt: sql`COALESCE(${scoutProfiles.verificationConsentedAt}, now())`,
        updatedAt: now,
      }).where(and(
        eq(scoutProfiles.userId, user.id),
        sql`EXISTS (
          SELECT 1 FROM ${users} AS active_scout
          WHERE active_scout.id = ${user.id}
            AND active_scout.role = 'scout'
            AND active_scout.status = 'active'
        )`,
      )).returning({ id: scoutProfiles.id }),
      db.update(users).set({
        firstName,
        lastName,
        phone: input.phone.trim(),
        emailNotificationsEnabled: input.emailNotificationsEnabled,
        smsNotificationsEnabled: input.smsNotificationsEnabled,
        smsConsentedAt: input.smsNotificationsEnabled ? user.smsConsentedAt ?? now : user.smsConsentedAt,
        updatedAt: now,
      }).where(and(
        eq(users.id, user.id),
        eq(users.role, "scout"),
        eq(users.status, "active"),
        sql`EXISTS (
          SELECT 1 FROM ${scoutProfiles} AS active_profile
          WHERE active_profile.user_id = ${user.id}
        )`,
      )).returning({ id: users.id }),
    ]);
    if (!profileRows[0] || !userRows[0]) throw new Error("Your active Scout profile could not be updated.");
    try {
      const clerk = await clerkClient();
      await clerk.users.updateUser(user.clerkUserId, { firstName, lastName });
    } catch (error) {
      console.warn("Scout settings saved, but Clerk name sync failed", error);
    }
    await tryAutoApproveScout(user.id);
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
    if (user.role !== "customer" || user.status !== "active") throw new Error("Only an active customer account can update a customer profile.");
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
    if (user.role !== "scout" || user.status !== "active") throw new Error("Only an active Scout account can update a profile photo.");
    if (!pathname.startsWith(`scout-headshots/${user.id}/`) || pathname.includes("..")) throw new Error("That profile photo path is not valid.");
    const db = getDb();
    const [existing] = await db.select({
      headshotPath: scoutProfiles.headshotPath,
      status: scoutProfiles.status,
    }).from(scoutProfiles).where(eq(scoutProfiles.userId, user.id)).limit(1);
    cleanupPath = existing?.headshotPath === pathname ? null : pathname;
    if (!existing || existing.status === "rejected") throw new Error("Your Scout profile is not eligible for photo uploads.");
    const activeMissionStatuses = ["claimed", "en_route", "onsite", "en_route_pickup", "at_pickup", "en_route_dropoff", "at_dropoff", "submitted", "disputed"] as const;
    const [activeMission] = await db.select({ id: missions.id }).from(missions).where(and(
      eq(missions.scoutId, user.id),
      inArray(missions.status, activeMissionStatuses),
      isNull(missions.archivedAt),
    )).limit(1);
    if (activeMission) throw new Error("Finish or resolve your active mission before changing the profile photo customers rely on.");
    const blob = await get(pathname, { access: "private" });
    if (
      !blob
      || blob.statusCode !== 200
      || blob.blob.pathname !== pathname
      || blob.blob.size <= 0
      || blob.blob.size > SCOUT_HEADSHOT_MAX_BYTES
    ) throw new Error("That profile photo is missing or has an unsupported format.");
    const bytes = Buffer.from(await new Response(blob.stream).arrayBuffer());
    if (bytes.byteLength !== blob.blob.size) throw new Error("That profile photo could not be read completely. Upload it again.");
    await validateScoutHeadshotBytes(bytes, blob.blob.contentType);
    const [savedPhoto] = await db.update(scoutProfiles).set({
      headshotPath: pathname,
      updatedAt: new Date(),
    }).where(and(
      eq(scoutProfiles.userId, user.id),
      eq(scoutProfiles.status, existing.status),
      sql`${scoutProfiles.headshotPath} IS NOT DISTINCT FROM ${existing.headshotPath}`,
      sql`NOT EXISTS (
        SELECT 1 FROM missions AS active_mission
        WHERE active_mission.scout_id = ${user.id}
          AND active_mission.status IN ('claimed', 'en_route', 'onsite', 'en_route_pickup', 'at_pickup', 'en_route_dropoff', 'at_dropoff', 'submitted', 'disputed')
          AND active_mission.archived_at IS NULL
      )`,
      sql`EXISTS (
        SELECT 1 FROM ${users} AS active_scout
        WHERE active_scout.id = ${user.id}
          AND active_scout.role = 'scout'
          AND active_scout.status = 'active'
      )`,
    )).returning({ id: scoutProfiles.id });
    if (!savedPhoto) throw new Error("Your Scout profile or active mission changed in another window. Refresh before trying again.");
    cleanupPath = null;
    await tryAutoApproveScout(user.id);
    // Do not hold the successful photo-save response open while the email
    // provider is contacted. The hourly worker covers profiles abandoned
    // before a headshot is saved.
    after(async () => {
      try {
        await sendScoutOnboardingWelcome(user.id);
      } catch (error) {
        console.warn("Scout photo saved, but the onboarding welcome could not be queued", { userId: user.id, error });
      }
    });
    if (existing.headshotPath && existing.headshotPath !== pathname) {
      try {
        await deleteScoutHeadshotIfUnreferenced(existing.headshotPath);
      } catch (error) {
        console.warn("Old Scout headshot could not be removed", error);
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
        await deleteScoutHeadshotIfUnreferenced(cleanupPath);
      } catch (cleanupError) {
        console.warn("Unattached Scout headshot could not be removed", cleanupError);
      }
    }
    return { ok: false, error: error instanceof Error ? error.message : "We could not save your profile photo." };
  }
}
