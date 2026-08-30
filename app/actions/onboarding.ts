"use server";

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  customerPreferredScouts,
  missionBundles,
  missionChecklistItems,
  missionRecurrences,
  missions,
  missionTemplates,
  missionUpdates,
  scoutProfiles,
  users,
} from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";
import { calculateMissionQuote, type MissionPriceQuote } from "@/lib/mission-pricing";
import { hashDeliveryPin, normalizeDeliveryPin } from "@/lib/delivery-pin";
import { calculateBundlePricing, calculateDiscountedMissionPrice, nextRecurrenceDate } from "@/lib/mission-features";
import { alertEligibleScouts } from "@/lib/notifications";
import { isMissionEligibleForScout } from "@/lib/scout-matching";
import { easternLocalDateTimeToUtc } from "@/lib/time";

export type MissionChecklistDraft = {
  prompt: string;
  responseType: "check" | "text" | "photo";
};

export type MissionRecurrence = "once" | "weekly" | "biweekly" | "monthly";

export type MissionInput = {
  type: "see" | "move" | "meet";
  address: string;
  addressLine2: string;
  city: string;
  zip: string;
  pickupName: string;
  pickupAddress: string;
  pickupAddressLine2: string;
  pickupCity: string;
  pickupState: string;
  pickupZip: string;
  pickupInstructions: string;
  dropoffName: string;
  dropoffAddress: string;
  dropoffAddressLine2: string;
  dropoffCity: string;
  dropoffState: string;
  dropoffZip: string;
  deliveryInstructions: string;
  largeItem: boolean;
  meetAuthorizedMinutes: number;
  scheduledFor: string;
  title: string;
  instructions: string;
  phone: string;
  sourceMissionId: string;
  templateId: string;
  preferredScoutId: string;
  enhancedReport: boolean;
  checklistItems: MissionChecklistDraft[];
  saveAsTemplate: boolean;
  templateName: string;
  recurrence: MissionRecurrence;
  recurrenceEndsOn: string;
  recurrenceScheduleId: string;
  recurrenceOccurrenceAt: string;
  deliveryMethod: "hand_to_recipient" | "leave_at_location";
  deliveryPinRequired: boolean;
  deliveryPin: string;
  addMoveLeg: boolean;
  bundleDropoffName: string;
  bundleDropoffAddress: string;
  bundleDropoffAddressLine2: string;
  bundleDropoffCity: string;
  bundleDropoffState: string;
  bundleDropoffZip: string;
  bundleDeliveryInstructions: string;
  bundleTitle: string;
  bundleInstructions: string;
  bundleLargeItem: boolean;
  bundleDeliveryMethod: "hand_to_recipient" | "leave_at_location";
  bundleDeliveryPinRequired: boolean;
  bundleDeliveryPin: string;
};

export type MissionCreationQuote = MissionPriceQuote & {
  listCustomerPriceCents: number;
  bundleDiscountCents: number;
  totalCustomerPriceCents: number;
  totalScoutPayoutCents: number;
  totalPlatformFeeCents: number;
  itemized: { label: string; customerPriceCents: number }[];
  bundledMoveQuote: MissionPriceQuote | null;
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
  smsNotificationsEnabled: boolean;
};

export type OnboardingResult = { ok: true; id: string; scoutUserId?: string } | { ok: false; error: string };

function required(value: string, label: string) {
  if (!value.trim()) throw new Error(`${label} is required.`);
}

const ENHANCED_REPORT_CUSTOMER_CENTS = 900;
const ENHANCED_REPORT_SCOUT_CENTS = 600;
const BUNDLE_DISCOUNT_CENTS = 400;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function getMissionPriceQuote(input: MissionInput): Promise<MissionCreationQuote> {
  await requireAppUser("customer");
  const base = await calculateMissionQuote(input);
  const enhancedCustomer = input.enhancedReport ? ENHANCED_REPORT_CUSTOMER_CENTS : 0;
  const enhancedScout = input.enhancedReport ? ENHANCED_REPORT_SCOUT_CENTS : 0;
  const rootLine = {
    customerPriceCents: base.customerPriceCents + enhancedCustomer,
    scoutPayoutCents: base.scoutPayoutCents + enhancedScout,
  };
  let bundledMoveQuote: MissionPriceQuote | null = null;
  if (input.addMoveLeg) {
    if (input.type !== "meet") throw new Error("A delivery extension can only be added to a Meet It mission.");
    bundledMoveQuote = await calculateMissionQuote(bundleMoveQuoteInput(input));
  }
  const bundle = calculateBundlePricing(
    bundledMoveQuote ? [rootLine, bundledMoveQuote] : [rootLine],
    bundledMoveQuote ? BUNDLE_DISCOUNT_CENTS : 0,
  );
  return {
    ...base,
    customerPriceCents: rootLine.customerPriceCents,
    scoutPayoutCents: rootLine.scoutPayoutCents,
    platformFeeCents: rootLine.customerPriceCents - rootLine.scoutPayoutCents,
    maximumCustomerPriceCents: base.maximumCustomerPriceCents + enhancedCustomer,
    maximumScoutPayoutCents: base.maximumScoutPayoutCents + enhancedScout,
    listCustomerPriceCents: bundle.listCustomerPriceCents,
    bundleDiscountCents: bundle.bundleDiscountCents,
    totalCustomerPriceCents: bundle.customerPriceCents,
    totalScoutPayoutCents: bundle.scoutPayoutCents,
    totalPlatformFeeCents: bundle.platformFeeCents,
    bundledMoveQuote,
    itemized: [
      { label: `${missionLabel(input.type)} service`, customerPriceCents: base.customerPriceCents },
      ...(input.enhancedReport ? [{ label: "Enhanced mission report", customerPriceCents: ENHANCED_REPORT_CUSTOMER_CENTS }] : []),
      ...(bundledMoveQuote ? [{ label: "Move It follow-up", customerPriceCents: bundledMoveQuote.customerPriceCents }] : []),
      ...(bundle.bundleDiscountCents ? [{ label: "Multi-mission discount", customerPriceCents: -bundle.bundleDiscountCents }] : []),
    ],
  };
}

export async function createMission(input: MissionInput): Promise<OnboardingResult> {
  try {
    validateMissionInput(input);
    const user = await requireAppUser("customer");
    const db = getDb();
    const [sourceMissionId, selectedTemplateId, preferredScoutId, reviewedRecurrence] = await Promise.all([
      validateOwnedSourceMission(db, user.id, input.sourceMissionId),
      validateOwnedTemplate(db, user.id, input.templateId),
      validatePreferredScout(db, user.id, input),
      validateReviewedRecurrence(db, user.id, input),
    ]);
    const amount = await getMissionPriceQuote(input);
    if (input.type === "move" && amount.routeSource !== "google") throw new Error("We could not verify the driving route. Please try again.");
    if (input.type !== "move" && !amount.pickupCoordinates) throw new Error("We could not verify the mission location. Please check the address and try again.");
    if (input.addMoveLeg && amount.bundledMoveQuote?.routeSource !== "google") throw new Error("We could not verify the follow-up delivery route. Please try again.");

    const now = new Date();
    const missionId = randomUUID();
    const bundleId = input.addMoveLeg ? randomUUID() : null;
    const childMissionId = input.addMoveLeg ? randomUUID() : null;
    const shouldCreateTemplate = !reviewedRecurrence && (input.saveAsTemplate || input.recurrence !== "once");
    const createdTemplateId = shouldCreateTemplate ? randomUUID() : null;
    const templateId = createdTemplateId ?? selectedTemplateId;
    const createdRecurrenceId = input.recurrence !== "once" && !reviewedRecurrence ? randomUUID() : null;
    const recurrenceId = reviewedRecurrence?.id ?? createdRecurrenceId;
    const scheduledFor = reviewedRecurrence?.occurrenceAt ?? (input.scheduledFor ? easternLocalDateTimeToUtc(input.scheduledFor) : null);
    const preferredScoutExclusiveUntil = preferredScoutId ? new Date(now.getTime() + 60 * 60 * 1000) : null;
    const pinPepper = ((input.type === "move" && input.deliveryPinRequired) || (input.addMoveLeg && input.bundleDeliveryPinRequired)) ? requireDeliveryPinSecret() : "";
    const deliveryPinHash = input.type === "move" && input.deliveryPinRequired
      ? hashDeliveryPin(input.deliveryPin, pinPepper, missionId)
      : null;
    const childDeliveryPinHash = childMissionId && input.bundleDeliveryPinRequired
      ? hashDeliveryPin(input.bundleDeliveryPin, pinPepper, childMissionId)
      : null;
    const childQuote = amount.bundledMoveQuote;
    const childDiscounted = childQuote ? calculateDiscountedMissionPrice(childQuote, BUNDLE_DISCOUNT_CENTS) : null;

    const rootMission: typeof missions.$inferInsert = {
      id: missionId,
      customerId: user.id,
      sourceMissionId,
      templateId,
      recurrenceId,
      recurrenceOccurrenceAt: reviewedRecurrence?.occurrenceAt ?? (createdRecurrenceId ? scheduledFor : null),
      preferredScoutId,
      preferredScoutExclusiveUntil,
      bundleId,
      bundleSequence: bundleId ? 1 : null,
      type: input.type,
      status: "open",
      title: input.title.trim(),
      instructions: input.instructions.trim(),
      addressLine1: (input.type === "move" ? input.pickupAddress : input.address).trim(),
      addressLine2: (input.type === "move" ? input.pickupAddressLine2 : input.addressLine2).trim() || null,
      city: (input.type === "move" ? input.pickupCity : input.city).trim(),
      state: input.type === "move" ? input.pickupState.trim().toUpperCase() : "NC",
      zip: (input.type === "move" ? input.pickupZip : input.zip).trim(),
      pickupName: input.type === "move" ? input.pickupName.trim() : null,
      pickupInstructions: input.type === "move" ? input.pickupInstructions.trim() || null : null,
      dropoffName: input.type === "move" ? input.dropoffName.trim() : null,
      dropoffAddressLine1: input.type === "move" ? input.dropoffAddress.trim() : null,
      dropoffAddressLine2: input.type === "move" ? input.dropoffAddressLine2.trim() || null : null,
      dropoffCity: input.type === "move" ? input.dropoffCity.trim() : null,
      dropoffState: input.type === "move" ? input.dropoffState.trim().toUpperCase() : null,
      dropoffZip: input.type === "move" ? input.dropoffZip.trim() : null,
      deliveryInstructions: input.type === "move" ? deliveryInstructionsWithMethod(input.deliveryMethod, input.deliveryInstructions) : null,
      deliveryPinRequired: input.type === "move" && input.deliveryPinRequired,
      deliveryPinHash,
      proofOfDeliveryRequired: input.type === "move",
      enhancedReportRequested: input.enhancedReport,
      largeItem: input.type === "move" && input.largeItem,
      scheduledFor,
      pickupLatitude: amount.pickupCoordinates?.latitude.toFixed(6) ?? null,
      pickupLongitude: amount.pickupCoordinates?.longitude.toFixed(6) ?? null,
      dropoffLatitude: amount.dropoffCoordinates?.latitude.toFixed(6) ?? null,
      dropoffLongitude: amount.dropoffCoordinates?.longitude.toFixed(6) ?? null,
      routeDistanceMeters: amount.routeDistanceMeters,
      routeDurationSeconds: amount.routeDurationSeconds,
      routePolyline: amount.routePolyline,
      routeSource: amount.routeSource,
      routeQuotedAt: amount.routeSource === "google" ? now : null,
      meetAuthorizedMinutes: input.type === "meet" ? input.meetAuthorizedMinutes : 60,
      maximumCustomerPriceCents: amount.maximumCustomerPriceCents,
      maximumScoutPayoutCents: amount.maximumScoutPayoutCents,
      customerPriceCents: amount.customerPriceCents,
      listCustomerPriceCents: amount.customerPriceCents,
      scoutPayoutCents: amount.scoutPayoutCents,
      platformFeeCents: amount.platformFeeCents,
    };

    const childMission: typeof missions.$inferInsert | null = childMissionId && bundleId && childQuote && childDiscounted ? {
      id: childMissionId,
      customerId: user.id,
      bundleId,
      bundleSequence: 2,
      predecessorMissionId: missionId,
      sourceMissionId,
      templateId,
      preferredScoutId,
      type: "move",
      status: "draft",
      title: input.bundleTitle.trim(),
      instructions: input.bundleInstructions.trim(),
      addressLine1: input.address.trim(),
      addressLine2: input.addressLine2.trim() || null,
      city: input.city.trim(),
      state: "NC",
      zip: input.zip.trim(),
      pickupName: input.title.trim(),
      pickupInstructions: "Continue this delivery after completing the Meet It appointment.",
      dropoffName: input.bundleDropoffName.trim(),
      dropoffAddressLine1: input.bundleDropoffAddress.trim(),
      dropoffAddressLine2: input.bundleDropoffAddressLine2.trim() || null,
      dropoffCity: input.bundleDropoffCity.trim(),
      dropoffState: input.bundleDropoffState.trim().toUpperCase(),
      dropoffZip: input.bundleDropoffZip.trim(),
      deliveryInstructions: deliveryInstructionsWithMethod(input.bundleDeliveryMethod, input.bundleDeliveryInstructions),
      deliveryPinRequired: input.bundleDeliveryPinRequired,
      deliveryPinHash: childDeliveryPinHash,
      proofOfDeliveryRequired: true,
      largeItem: input.bundleLargeItem,
      scheduledFor,
      pickupLatitude: childQuote.pickupCoordinates?.latitude.toFixed(6) ?? null,
      pickupLongitude: childQuote.pickupCoordinates?.longitude.toFixed(6) ?? null,
      dropoffLatitude: childQuote.dropoffCoordinates?.latitude.toFixed(6) ?? null,
      dropoffLongitude: childQuote.dropoffCoordinates?.longitude.toFixed(6) ?? null,
      routeDistanceMeters: childQuote.routeDistanceMeters,
      routeDurationSeconds: childQuote.routeDurationSeconds,
      routePolyline: childQuote.routePolyline,
      routeSource: childQuote.routeSource,
      routeQuotedAt: now,
      customerPriceCents: childDiscounted.customerPriceCents,
      listCustomerPriceCents: childQuote.customerPriceCents,
      bundleDiscountCents: childDiscounted.bundleDiscountCents,
      scoutPayoutCents: childQuote.scoutPayoutCents,
      platformFeeCents: childDiscounted.platformFeeCents,
      maximumCustomerPriceCents: childDiscounted.customerPriceCents,
      maximumScoutPayoutCents: childQuote.scoutPayoutCents,
    } : null;

    const noOp = () => db.select({ id: users.id }).from(users).where(eq(users.id, user.id)).limit(0);
    const templateQuery = createdTemplateId
      ? db.insert(missionTemplates).values({
          id: createdTemplateId,
          customerId: user.id,
          name: (input.templateName.trim() || `${input.title.trim()} template`).slice(0, 120),
          type: input.type,
          configurationJson: templateConfiguration(input),
          preferredScoutId,
          lastUsedAt: now,
        })
      : noOp();
    const recurrence = createdRecurrenceId && createdTemplateId && scheduledFor ? recurrenceConfiguration(input, scheduledFor) : null;
    const recurrenceNextRunAt = recurrence ? nextRecurrenceDate(recurrence.startsAt, recurrence.rule, {
      timeZone: "America/New_York",
      anchor: recurrence.startsAt,
    }) : null;
    const recurrenceEndsBeforeNext = Boolean(recurrence?.endsAt && recurrenceNextRunAt && recurrenceNextRunAt > recurrence.endsAt);
    const recurrenceQuery = createdRecurrenceId && createdTemplateId && recurrence
      ? db.insert(missionRecurrences).values({
          id: createdRecurrenceId,
          customerId: user.id,
          templateId: createdTemplateId,
          status: recurrenceEndsBeforeNext ? "ended" : "active",
          recurrenceRule: recurrence.rule,
          startsAt: recurrence.startsAt,
          endsAt: recurrence.endsAt,
          nextRunAt: recurrenceEndsBeforeNext ? null : recurrenceNextRunAt,
          preferredScoutId,
        })
      : noOp();
    const bundleQuery = bundleId
      ? db.insert(missionBundles).values({
          id: bundleId,
          customerId: user.id,
          title: `${input.title.trim()} + delivery`,
          status: "open",
          activeSequence: 1,
          listCustomerPriceCents: amount.listCustomerPriceCents,
          bundleDiscountCents: amount.bundleDiscountCents,
          customerPriceCents: amount.totalCustomerPriceCents,
          scoutPayoutCents: amount.totalScoutPayoutCents,
          platformFeeCents: amount.totalPlatformFeeCents,
        })
      : noOp();
    const childQuery = childMission ? db.insert(missions).values(childMission) : noOp();
    const checklistQuery = input.enhancedReport
      ? db.insert(missionChecklistItems).values(input.checklistItems.map((item, index) => ({
          missionId,
          sequence: index + 1,
          prompt: item.prompt.trim(),
          responseType: item.responseType,
          required: true,
        })))
      : noOp();
    const touchTemplateQuery = selectedTemplateId && !createdTemplateId
      ? db.update(missionTemplates).set({ lastUsedAt: now, updatedAt: now }).where(and(eq(missionTemplates.id, selectedTemplateId), eq(missionTemplates.customerId, user.id)))
      : noOp();

    await db.batch([
      db.update(users).set({ phone: input.phone.trim(), updatedAt: now }).where(eq(users.id, user.id)),
      templateQuery,
      recurrenceQuery,
      bundleQuery,
      db.insert(missions).values(rootMission),
      childQuery,
      checklistQuery,
      touchTemplateQuery,
      db.insert(missionUpdates).values([
        { missionId, authorId: user.id, status: "open", message: preferredScoutId ? "Mission offered to the preferred Scout first." : "Mission published automatically to eligible Scouts." },
        ...(childMissionId ? [{ missionId: childMissionId, authorId: user.id, status: "draft" as const, message: "Follow-up Move It leg queued behind the Meet It mission." }] : []),
      ]),
    ]);

    try {
      await alertEligibleScouts(missionId);
    } catch (alertError) {
      console.error("Mission published, but Scout alerts could not be delivered", alertError);
    }
    revalidatePath("/dashboard/customer");
    revalidatePath("/dashboard/scout");
    revalidatePath("/control-room");

    return { ok: true, id: missionId };
  } catch (error) {
    if (input.recurrenceScheduleId && isRecurringOccurrenceConflict(error)) {
      return { ok: false, error: "This recurring occurrence was already published. Return to Saved & recurring to review the next available date." };
    }
    console.error("Mission onboarding failed", error);
    return { ok: false, error: error instanceof Error ? error.message : "We could not save this mission." };
  }
}

function validateMissionInput(input: MissionInput) {
  if (input.type === "move") {
    validateMoveStops({
      pickupName: input.pickupName,
      pickupAddress: input.pickupAddress,
      pickupCity: input.pickupCity,
      pickupState: input.pickupState,
      pickupZip: input.pickupZip,
      dropoffName: input.dropoffName,
      dropoffAddress: input.dropoffAddress,
      dropoffCity: input.dropoffCity,
      dropoffState: input.dropoffState,
      dropoffZip: input.dropoffZip,
    });
    validateDeliveryConfirmation(input.deliveryMethod, input.deliveryPinRequired, input.deliveryPin);
  } else {
    required(input.address, "Mission address");
    required(input.city, "City");
    required(input.zip, "ZIP code");
    validateZip(input.zip, "mission");
  }
  required(input.title, input.type === "move" ? "Item description" : "Mission title");
  required(input.instructions, input.type === "move" ? "Item and handling details" : "Instructions");
  required(input.phone, "Phone number");
  if (input.type === "meet" && ![60, 120, 180, 240].includes(input.meetAuthorizedMinutes)) throw new Error("Choose a valid maximum appointment time.");
  if (input.enhancedReport) {
    if (!input.checklistItems.length) throw new Error("Add at least one required item to the enhanced report.");
    if (input.checklistItems.length > 10) throw new Error("Enhanced reports support up to 10 checklist items.");
    input.checklistItems.forEach((item) => {
      const prompt = item.prompt.trim();
      if (prompt.length < 3 || prompt.length > 180) throw new Error("Each checklist item must be between 3 and 180 characters.");
      if (!(["check", "text", "photo"] as string[]).includes(item.responseType)) throw new Error("Choose a valid checklist response type.");
    });
  }
  if (!(["once", "weekly", "biweekly", "monthly"] as string[]).includes(input.recurrence)) throw new Error("Choose a valid repeat schedule.");
  const hasRecurrenceSchedule = Boolean(input.recurrenceScheduleId.trim());
  const hasRecurrenceOccurrence = Boolean(input.recurrenceOccurrenceAt.trim());
  if (hasRecurrenceSchedule !== hasRecurrenceOccurrence) throw new Error("The recurring occurrence link is incomplete. Open it again from Saved & recurring.");
  if (hasRecurrenceSchedule && input.recurrence !== "once") throw new Error("Publish this reviewed occurrence before creating a new repeat schedule.");
  if (hasRecurrenceSchedule && input.saveAsTemplate) throw new Error("This occurrence already uses its recurring mission template.");
  if (input.recurrence !== "once" && !input.scheduledFor) throw new Error("Recurring missions need a scheduled start date and time.");
  if (input.recurrenceEndsOn && input.recurrence === "once") throw new Error("An end date can only be used with a recurring mission.");
  if (input.addMoveLeg) {
    if (input.type !== "meet") throw new Error("A Move It follow-up can only be added to a Meet It mission.");
    validateMoveStops({
      pickupName: input.title,
      pickupAddress: input.address,
      pickupCity: input.city,
      pickupState: "NC",
      pickupZip: input.zip,
      dropoffName: input.bundleDropoffName,
      dropoffAddress: input.bundleDropoffAddress,
      dropoffCity: input.bundleDropoffCity,
      dropoffState: input.bundleDropoffState,
      dropoffZip: input.bundleDropoffZip,
    });
    required(input.bundleTitle, "Follow-up item description");
    required(input.bundleInstructions, "Follow-up item and handling details");
    validateDeliveryConfirmation(input.bundleDeliveryMethod, input.bundleDeliveryPinRequired, input.bundleDeliveryPin);
  }
}

function validateMoveStops(input: {
  pickupName: string;
  pickupAddress: string;
  pickupCity: string;
  pickupState: string;
  pickupZip: string;
  dropoffName: string;
  dropoffAddress: string;
  dropoffCity: string;
  dropoffState: string;
  dropoffZip: string;
}) {
  required(input.pickupName, "Pickup name");
  required(input.pickupAddress, "Pickup address");
  required(input.pickupCity, "Pickup city");
  required(input.pickupState, "Pickup state");
  required(input.pickupZip, "Pickup ZIP code");
  required(input.dropoffName, "Drop-off name");
  required(input.dropoffAddress, "Drop-off address");
  required(input.dropoffCity, "Drop-off city");
  required(input.dropoffState, "Drop-off state");
  required(input.dropoffZip, "Drop-off ZIP code");
  validateZip(input.pickupZip, "pickup");
  validateZip(input.dropoffZip, "drop-off");
}

function validateZip(value: string, label: string) {
  if (!/^\d{5}(?:-\d{4})?$/.test(value.trim())) throw new Error(`Enter a valid ${label} ZIP code.`);
}

function validateDeliveryConfirmation(method: MissionInput["deliveryMethod"], pinRequired: boolean, pin: string) {
  if (method !== "hand_to_recipient" && method !== "leave_at_location") throw new Error("Choose a valid delivery method.");
  if (method === "leave_at_location" && pinRequired) throw new Error("A recipient PIN can only be used when the delivery is handed to someone.");
  if (pinRequired) normalizeDeliveryPin(pin);
}

function bundleMoveQuoteInput(input: MissionInput): MissionInput {
  return {
    ...input,
    type: "move",
    pickupName: input.title,
    pickupAddress: input.address,
    pickupAddressLine2: input.addressLine2,
    pickupCity: input.city,
    pickupState: "NC",
    pickupZip: input.zip,
    dropoffName: input.bundleDropoffName,
    dropoffAddress: input.bundleDropoffAddress,
    dropoffAddressLine2: input.bundleDropoffAddressLine2,
    dropoffCity: input.bundleDropoffCity,
    dropoffState: input.bundleDropoffState,
    dropoffZip: input.bundleDropoffZip,
    largeItem: input.bundleLargeItem,
  };
}

function missionLabel(type: MissionInput["type"]) {
  return type === "see" ? "See It" : type === "move" ? "Move It" : "Meet It";
}

function templateConfiguration(input: MissionInput): Record<string, unknown> {
  return {
    ...input,
    phone: "",
    sourceMissionId: "",
    templateId: "",
    deliveryPin: "",
    bundleDeliveryPin: "",
    recurrence: "once",
    recurrenceEndsOn: "",
    recurrenceScheduleId: "",
    recurrenceOccurrenceAt: "",
    saveAsTemplate: false,
    templateName: "",
    scheduledFor: "",
  };
}

function deliveryInstructionsWithMethod(method: MissionInput["deliveryMethod"], instructions: string) {
  const methodLine = method === "hand_to_recipient" ? "Delivery method: Hand directly to the recipient." : "Delivery method: Leave at the customer-approved location.";
  return [methodLine, instructions.trim()].filter(Boolean).join("\n\n");
}

function recurrenceConfiguration(input: MissionInput, startsAt: Date) {
  const rule = input.recurrence === "weekly"
    ? "FREQ=WEEKLY;INTERVAL=1"
    : input.recurrence === "biweekly"
      ? "FREQ=WEEKLY;INTERVAL=2"
      : "FREQ=MONTHLY;INTERVAL=1";
  const endsAt = input.recurrenceEndsOn ? easternLocalDateTimeToUtc(`${input.recurrenceEndsOn}T23:59`) : null;
  if (endsAt && endsAt <= startsAt) throw new Error("The recurring schedule end date must be after its first mission.");
  return { rule, endsAt, startsAt };
}

function requireDeliveryPinSecret() {
  const secret = process.env.DELIVERY_PIN_SECRET?.trim();
  if (!secret) throw new Error("Secure delivery PINs are temporarily unavailable. Please turn off PIN confirmation or contact support.");
  return secret;
}

async function validateOwnedSourceMission(db: ReturnType<typeof getDb>, customerId: string, sourceMissionId: string) {
  if (!sourceMissionId) return null;
  if (!UUID_PATTERN.test(sourceMissionId)) throw new Error("The mission selected for Book Again is invalid.");
  const [source] = await db.select({ id: missions.id }).from(missions).where(and(eq(missions.id, sourceMissionId), eq(missions.customerId, customerId))).limit(1);
  if (!source) throw new Error("The mission selected for Book Again is no longer available.");
  return source.id;
}

async function validateOwnedTemplate(db: ReturnType<typeof getDb>, customerId: string, templateId: string) {
  if (!templateId) return null;
  if (!UUID_PATTERN.test(templateId)) throw new Error("The selected mission template is invalid.");
  const [template] = await db.select({ id: missionTemplates.id }).from(missionTemplates).where(and(eq(missionTemplates.id, templateId), eq(missionTemplates.customerId, customerId), isNull(missionTemplates.archivedAt))).limit(1);
  if (!template) throw new Error("The selected mission template is no longer available.");
  return template.id;
}

async function validateReviewedRecurrence(db: ReturnType<typeof getDb>, customerId: string, input: MissionInput) {
  const recurrenceId = input.recurrenceScheduleId.trim();
  const occurrenceValue = input.recurrenceOccurrenceAt.trim();
  if (!recurrenceId && !occurrenceValue) return null;
  if (!recurrenceId || !occurrenceValue || !UUID_PATTERN.test(recurrenceId) || !UUID_PATTERN.test(input.templateId)) {
    throw new Error("The recurring occurrence link is invalid. Open it again from Saved & recurring.");
  }

  const occurrenceAt = new Date(occurrenceValue);
  if (Number.isNaN(occurrenceAt.getTime())) throw new Error("The recurring occurrence date is invalid.");
  const [recurrence] = await db.select({
    id: missionRecurrences.id,
    lastRunAt: missionRecurrences.lastRunAt,
    nextRunAt: missionRecurrences.nextRunAt,
  }).from(missionRecurrences).where(and(
    eq(missionRecurrences.id, recurrenceId),
    eq(missionRecurrences.customerId, customerId),
    eq(missionRecurrences.templateId, input.templateId),
  )).limit(1);
  if (!recurrence) throw new Error("That recurring schedule is no longer available for this account.");
  const isCurrentOccurrence = [recurrence.lastRunAt, recurrence.nextRunAt]
    .some((candidate) => candidate?.getTime() === occurrenceAt.getTime());
  if (!isCurrentOccurrence) throw new Error("That recurring occurrence is no longer current. Open the latest date from Saved & recurring.");

  const [existing] = await db.select({ id: missions.id }).from(missions).where(and(
    eq(missions.customerId, customerId),
    eq(missions.recurrenceId, recurrence.id),
    eq(missions.recurrenceOccurrenceAt, occurrenceAt),
  )).limit(1);
  if (existing) throw new Error("This recurring occurrence was already published. Return to Saved & recurring to review the next available date.");
  return { id: recurrence.id, occurrenceAt };
}

async function validatePreferredScout(db: ReturnType<typeof getDb>, customerId: string, input: MissionInput) {
  const scoutId = input.preferredScoutId.trim();
  if (!scoutId) return null;
  if (!UUID_PATTERN.test(scoutId)) throw new Error("The preferred Scout selection is invalid.");
  const [[profile], [saved], [completed]] = await Promise.all([
    db.select().from(scoutProfiles).where(and(eq(scoutProfiles.userId, scoutId), eq(scoutProfiles.status, "approved"))).limit(1),
    db.select({ id: customerPreferredScouts.id }).from(customerPreferredScouts).where(and(eq(customerPreferredScouts.customerId, customerId), eq(customerPreferredScouts.scoutId, scoutId))).limit(1),
    db.select({ id: missions.id }).from(missions).where(and(eq(missions.customerId, customerId), eq(missions.scoutId, scoutId), eq(missions.status, "completed"))).limit(1),
  ]);
  if (!profile || (!saved && !completed)) throw new Error("That Scout is not available for preferred rebooking.");
  const rootMission = { type: input.type, zip: input.type === "move" ? input.pickupZip : input.zip, largeItem: input.type === "move" && input.largeItem };
  if (!isMissionEligibleForScout(rootMission, profile)) throw new Error("The preferred Scout is not eligible for this mission.");
  if (input.addMoveLeg && !isMissionEligibleForScout({ type: "move", zip: input.zip, largeItem: input.bundleLargeItem }, profile)) throw new Error("The preferred Scout is not eligible for the delivery extension.");
  return scoutId;
}

function isRecurringOccurrenceConflict(error: unknown) {
  const details = error as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
  const cause = details.cause as { code?: unknown; constraint?: unknown; message?: unknown } | undefined;
  const code = String(details.code ?? cause?.code ?? "");
  const text = [details.constraint, details.message, cause?.constraint, cause?.message].filter(Boolean).join(" ");
  return code === "23505" && /missions_recurrence_occurrence_idx|recurrence_occurrence/i.test(text);
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
    if (!/^\d{5}(?:-\d{4})?$/.test(input.homeZip.trim())) throw new Error("Enter a valid ZIP code.");

    const user = await requireAppUser("scout");
    const db = getDb();
    await db
      .update(users)
      .set({
        role: "scout",
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        phone: input.phone.trim(),
        smsNotificationsEnabled: input.smsNotificationsEnabled,
        smsConsentedAt: input.smsNotificationsEnabled ? user.smsConsentedAt ?? new Date() : user.smsConsentedAt,
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

    return { ok: true, id: profile.id, scoutUserId: user.id };
  } catch (error) {
    console.error("Scout onboarding failed", error);
    return { ok: false, error: error instanceof Error ? error.message : "We could not save your application." };
  }
}
