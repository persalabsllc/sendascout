"use server";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { missions, scoutProfiles, users } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";

export type MissionInput = {
  type: "see" | "move" | "meet";
  address: string;
  city: string;
  zip: string;
  scheduledFor: string;
  title: string;
  instructions: string;
  phone: string;
};

export type ScoutInput = {
  firstName: string;
  lastName: string;
  phone: string;
  homeZip: string;
  radius: number;
  vehicleType: string;
  experience: string;
  canSee: boolean;
  canMove: boolean;
  canMeet: boolean;
  consent: boolean;
};

export type OnboardingResult = { ok: true; id: string } | { ok: false; error: string };

const pricing = {
  see: { customer: 3900, scout: 2400 },
  move: { customer: 4900, scout: 3000 },
  meet: { customer: 4900, scout: 3000 },
} as const;

function required(value: string, label: string) {
  if (!value.trim()) throw new Error(`${label} is required.`);
}

export async function createMission(input: MissionInput): Promise<OnboardingResult> {
  try {
    required(input.address, "Mission address");
    required(input.city, "City");
    required(input.zip, "ZIP code");
    required(input.title, "Mission title");
    required(input.instructions, "Instructions");
    required(input.phone, "Phone number");
    if (!/^\\d{5}(?:-\\d{4})?$/.test(input.zip.trim())) throw new Error("Enter a valid ZIP code.");

    const user = await requireAppUser("customer");
    const amount = pricing[input.type];
    const db = getDb();

    await db.update(users).set({ phone: input.phone.trim(), updatedAt: new Date() }).where(eq(users.id, user.id));
    const [mission] = await db
      .insert(missions)
      .values({
        customerId: user.id,
        type: input.type,
        title: input.title.trim(),
        instructions: input.instructions.trim(),
        addressLine1: input.address.trim(),
        city: input.city.trim(),
        zip: input.zip.trim(),
        scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
        customerPriceCents: amount.customer,
        scoutPayoutCents: amount.scout,
        platformFeeCents: amount.customer - amount.scout,
      })
      .returning({ id: missions.id });

    return { ok: true, id: mission.id };
  } catch (error) {
    console.error("Mission onboarding failed", error);
    return { ok: false, error: error instanceof Error ? error.message : "We could not save this mission." };
  }
}

export async function createScoutApplication(input: ScoutInput): Promise<OnboardingResult> {
  try {
    required(input.firstName, "First name");
    required(input.lastName, "Last name");
    required(input.phone, "Mobile number");
    required(input.homeZip, "Home ZIP code");
    required(input.vehicleType, "Vehicle access");
    if (!input.consent) throw new Error("You must agree to verification before joining.");
    if (!input.canSee && !input.canMove && !input.canMeet) throw new Error("Select at least one mission type.");
    if (!/^\\d{5}(?:-\\d{4})?$/.test(input.homeZip.trim())) throw new Error("Enter a valid ZIP code.");

    const user = await requireAppUser("scout");
    const db = getDb();
    await db
      .update(users)
      .set({
        role: "scout",
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        phone: input.phone.trim(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    const [profile] = await db
      .insert(scoutProfiles)
      .values({
        userId: user.id,
        homeZip: input.homeZip.trim(),
        serviceRadiusMiles: input.radius,
        vehicleType: input.vehicleType,
        experience: input.experience.trim() || null,
        canSee: input.canSee,
        canMove: input.canMove,
        canMeet: input.canMeet,
        verificationConsentedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: scoutProfiles.userId,
        set: {
          homeZip: input.homeZip.trim(),
          serviceRadiusMiles: input.radius,
          vehicleType: input.vehicleType,
          experience: input.experience.trim() || null,
          canSee: input.canSee,
          canMove: input.canMove,
          canMeet: input.canMeet,
          verificationConsentedAt: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning({ id: scoutProfiles.id });

    return { ok: true, id: profile.id };
  } catch (error) {
    console.error("Scout onboarding failed", error);
    return { ok: false, error: error instanceof Error ? error.message : "We could not save your application." };
  }
}
