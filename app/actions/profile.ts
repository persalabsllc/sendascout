"use server";

import { clerkClient } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { scoutProfiles, users } from "@/db/schema";
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
};

export type ProfileResult = { ok: true } | { ok: false; error: string };
export type ScoutSettingsInput = { homeZip: string; serviceRadiusMiles: number; vehicleType: string; canSee: boolean; canMove: boolean; canMeet: boolean };

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
