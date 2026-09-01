import { auth } from "@clerk/nextjs/server";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import type { MissionInput } from "@/app/actions/onboarding";
import { OnboardingForm, type PreferredScoutOption } from "@/components/onboarding-form";
import { getDb } from "@/db";
import { customerPreferredScouts, missionChecklistItems, missionRecurrences, missions, missionTemplates, scoutProfiles, users } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";
import { scoutClaimReadinessConditions } from "@/lib/scout-claim-readiness";
import { getStripeLivemode } from "@/lib/stripe";
import { dateTimeLocalValue } from "@/lib/time";

type RequestSearchParams = { type?: string; repeat?: string; template?: string; recurrence?: string; occurrence?: string };

export default async function RequestPage({ searchParams }: { searchParams: Promise<RequestSearchParams> }) {
  const params = await searchParams;
  const requestPath = requestPathFor(params);
  const { userId } = await auth();
  if (!userId) redirect(`/sign-in?redirect_url=${encodeURIComponent(requestPath)}`);
  const user = await requireAppUser("customer");
  if (!user.profileCompletedAt) redirect(`/dashboard/customer/profile?next=${encodeURIComponent(requestPath)}`);

  const db = getDb();
  const preferredScouts = await loadPreferredScouts(db, user.id);
  let initialMission: Partial<MissionInput> | undefined;
  if (params.recurrence || params.occurrence) {
    if (!validUuid(params.template) || !validUuid(params.recurrence)) redirect("/dashboard/customer/saved");
    initialMission = await loadTemplatePrefill(db, user.id, params.template);
    if (!initialMission) redirect("/dashboard/customer/saved");
    const reviewedOccurrence = await loadRecurrenceOccurrence(db, user.id, params.template, params.recurrence, params.occurrence);
    if (!reviewedOccurrence) redirect("/dashboard/customer/saved");
    initialMission = {
      ...initialMission,
      scheduledFor: dateTimeLocalValue(reviewedOccurrence.occurrenceAt, reviewedOccurrence.timeZone),
      timeZone: reviewedOccurrence.timeZone,
      recurrence: "once",
      recurrenceEndsOn: "",
      recurrenceScheduleId: reviewedOccurrence.recurrenceId,
      recurrenceOccurrenceAt: reviewedOccurrence.occurrenceAt.toISOString(),
    };
  } else if (validUuid(params.repeat)) initialMission = await loadMissionPrefill(db, user.id, params.repeat);
  else if (validUuid(params.template)) initialMission = await loadTemplatePrefill(db, user.id, params.template);
  if (initialMission?.preferredScoutId && !preferredScouts.some((scout) => scout.id === initialMission?.preferredScoutId)) initialMission.preferredScoutId = "";

  const typeFromPath = params.type === "move-it" ? "move" : params.type === "meet-it" ? "meet" : "see";
  return <OnboardingForm
    mode="customer"
    initialMissionType={initialMission?.type ?? typeFromPath}
    initialMission={initialMission}
    preferredScouts={preferredScouts}
    initialMissionAddress={{ address: user.addressLine1 ?? "", addressLine2: user.addressLine2 ?? "", city: user.city ?? "", state: user.state ?? "", zip: user.zip ?? "" }}
    initialPhone={user.phone ?? ""}
  />;
}

function requestPathFor(params: RequestSearchParams) {
  const query = new URLSearchParams();
  if (params.type) query.set("type", params.type);
  if (params.repeat) query.set("repeat", params.repeat);
  if (params.template) query.set("template", params.template);
  if (params.recurrence) query.set("recurrence", params.recurrence);
  if (params.occurrence) query.set("occurrence", params.occurrence);
  return query.size ? `/request?${query.toString()}` : "/request";
}

async function loadMissionPrefill(db: ReturnType<typeof getDb>, customerId: string, missionId: string): Promise<Partial<MissionInput> | undefined> {
  let [mission] = await db.select().from(missions).where(and(eq(missions.id, missionId), eq(missions.customerId, customerId), isNull(missions.archivedAt))).limit(1);
  if (!mission) return undefined;
  if (mission.bundleId && mission.bundleSequence !== 1) {
    const [root] = await db.select().from(missions).where(and(eq(missions.bundleId, mission.bundleId), eq(missions.bundleSequence, 1), eq(missions.customerId, customerId), isNull(missions.archivedAt))).limit(1);
    if (root) mission = root;
  }
  const [checklist, bundledLeg] = await Promise.all([
    db.select().from(missionChecklistItems).where(eq(missionChecklistItems.missionId, mission.id)).orderBy(missionChecklistItems.sequence),
    mission.bundleId && mission.bundleSequence === 1
      ? db.select().from(missions).where(and(eq(missions.bundleId, mission.bundleId), eq(missions.bundleSequence, 2))).limit(1).then((rows) => rows[0])
      : Promise.resolve(undefined),
  ]);
  return {
    type: mission.type,
    sourceMissionId: mission.id,
    templateId: "",
    preferredScoutId: mission.scoutId ?? mission.preferredScoutId ?? "",
    address: mission.type === "move" ? "" : mission.addressLine1,
    addressLine2: mission.type === "move" ? "" : mission.addressLine2 ?? "",
    city: mission.type === "move" ? "" : mission.city,
    state: mission.type === "move" ? "" : mission.state,
    zip: mission.type === "move" ? "" : mission.zip,
    pickupName: mission.pickupName ?? "",
    pickupAddress: mission.type === "move" ? mission.addressLine1 : "",
    pickupAddressLine2: mission.type === "move" ? mission.addressLine2 ?? "" : "",
    pickupCity: mission.type === "move" ? mission.city : "",
    pickupState: mission.type === "move" ? mission.state : "",
    pickupZip: mission.type === "move" ? mission.zip : "",
    pickupInstructions: mission.pickupInstructions ?? "",
    dropoffName: mission.dropoffName ?? "",
    dropoffAddress: mission.dropoffAddressLine1 ?? "",
    dropoffAddressLine2: mission.dropoffAddressLine2 ?? "",
    dropoffCity: mission.dropoffCity ?? "",
    dropoffState: mission.dropoffState ?? "",
    dropoffZip: mission.dropoffZip ?? "",
    deliveryInstructions: stripDeliveryMethodLine(mission.deliveryInstructions),
    deliveryMethod: deliveryMethodFromInstructions(mission.deliveryInstructions, mission.deliveryPinRequired),
    deliveryPinRequired: mission.deliveryPinRequired,
    deliveryPin: "",
    largeItem: mission.largeItem,
    meetAuthorizedMinutes: mission.meetAuthorizedMinutes,
    scheduledFor: "",
    timeZone: mission.timezone,
    title: mission.title,
    instructions: mission.instructions,
    enhancedReport: mission.enhancedReportRequested,
    checklistItems: checklist.map((item) => ({ prompt: item.prompt, responseType: item.responseType === "photo" ? "photo" : item.responseType === "check" ? "check" : "text" })),
    recurrence: "once",
    recurrenceEndsOn: "",
    recurrenceScheduleId: "",
    recurrenceOccurrenceAt: "",
    saveAsTemplate: false,
    templateName: "",
    addMoveLeg: Boolean(bundledLeg),
    ...(bundledLeg ? bundleLegPrefill(bundledLeg) : {}),
  };
}

async function loadTemplatePrefill(db: ReturnType<typeof getDb>, customerId: string, templateId: string): Promise<Partial<MissionInput> | undefined> {
  const [template] = await db.select().from(missionTemplates).where(and(eq(missionTemplates.id, templateId), eq(missionTemplates.customerId, customerId), isNull(missionTemplates.archivedAt))).limit(1);
  if (!template) return undefined;
  return {
    ...sanitizeTemplateConfiguration(template.configurationJson),
    type: template.type,
    templateId: template.id,
    sourceMissionId: "",
    preferredScoutId: template.preferredScoutId ?? "",
    deliveryPin: "",
    bundleDeliveryPin: "",
    scheduledFor: "",
    recurrence: "once",
    recurrenceEndsOn: "",
    recurrenceScheduleId: "",
    recurrenceOccurrenceAt: "",
    saveAsTemplate: false,
    templateName: "",
  };
}

function bundleLegPrefill(leg: typeof missions.$inferSelect): Partial<MissionInput> {
  return {
    bundleDropoffName: leg.dropoffName ?? "",
    bundleDropoffAddress: leg.dropoffAddressLine1 ?? "",
    bundleDropoffAddressLine2: leg.dropoffAddressLine2 ?? "",
    bundleDropoffCity: leg.dropoffCity ?? "",
    bundleDropoffState: leg.dropoffState ?? "",
    bundleDropoffZip: leg.dropoffZip ?? "",
    bundleDeliveryInstructions: stripDeliveryMethodLine(leg.deliveryInstructions),
    bundleTitle: leg.title,
    bundleInstructions: leg.instructions,
    bundleLargeItem: leg.largeItem,
    bundleDeliveryMethod: deliveryMethodFromInstructions(leg.deliveryInstructions, leg.deliveryPinRequired),
    bundleDeliveryPinRequired: leg.deliveryPinRequired,
    bundleDeliveryPin: "",
  };
}

function sanitizeTemplateConfiguration(value: Record<string, unknown>): Partial<MissionInput> {
  const safe: Partial<MissionInput> = {};
  const stringKeys: (keyof MissionInput)[] = [
    "address", "addressLine2", "city", "state", "zip", "timeZone", "pickupName", "pickupAddress", "pickupAddressLine2", "pickupCity", "pickupState", "pickupZip", "pickupInstructions",
    "dropoffName", "dropoffAddress", "dropoffAddressLine2", "dropoffCity", "dropoffState", "dropoffZip", "deliveryInstructions", "title", "instructions",
    "bundleDropoffName", "bundleDropoffAddress", "bundleDropoffAddressLine2", "bundleDropoffCity", "bundleDropoffState", "bundleDropoffZip", "bundleDeliveryInstructions", "bundleTitle", "bundleInstructions",
  ];
  for (const key of stringKeys) if (typeof value[key] === "string") Object.assign(safe, { [key]: value[key] });
  for (const key of ["largeItem", "enhancedReport", "deliveryPinRequired", "addMoveLeg", "bundleLargeItem", "bundleDeliveryPinRequired"] as const) if (typeof value[key] === "boolean") Object.assign(safe, { [key]: value[key] });
  if (value.deliveryMethod === "hand_to_recipient" || value.deliveryMethod === "leave_at_location") safe.deliveryMethod = value.deliveryMethod;
  if (value.bundleDeliveryMethod === "hand_to_recipient" || value.bundleDeliveryMethod === "leave_at_location") safe.bundleDeliveryMethod = value.bundleDeliveryMethod;
  if (typeof value.meetAuthorizedMinutes === "number" && [60, 120, 180, 240].includes(value.meetAuthorizedMinutes)) safe.meetAuthorizedMinutes = value.meetAuthorizedMinutes;
  if (Array.isArray(value.checklistItems)) safe.checklistItems = value.checklistItems.slice(0, 10).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.prompt !== "string") return [];
    const responseType = row.responseType === "photo" ? "photo" : row.responseType === "check" ? "check" : "text";
    return [{ prompt: row.prompt.slice(0, 180), responseType }];
  });
  return safe;
}

async function loadPreferredScouts(db: ReturnType<typeof getDb>, customerId: string): Promise<PreferredScoutOption[]> {
  const claimReadiness = scoutClaimReadinessConditions(getStripeLivemode());
  const [history, saved] = await Promise.all([
    db.select({ id: users.id, firstName: users.firstName, completedMissions: scoutProfiles.completedMissions })
      .from(missions)
      .innerJoin(users, eq(missions.scoutId, users.id))
      .innerJoin(scoutProfiles, eq(scoutProfiles.userId, users.id))
      .where(and(
        eq(missions.customerId, customerId),
        eq(missions.status, "completed"),
        isNotNull(missions.scoutId),
        ...claimReadiness,
      ))
      .orderBy(desc(missions.completedAt)),
    db.select({ id: users.id, firstName: users.firstName, completedMissions: scoutProfiles.completedMissions })
      .from(customerPreferredScouts)
      .innerJoin(users, eq(customerPreferredScouts.scoutId, users.id))
      .innerJoin(scoutProfiles, eq(scoutProfiles.userId, users.id))
      .where(and(
        eq(customerPreferredScouts.customerId, customerId),
        ...claimReadiness,
      )),
  ]);
  const unique = new Map<string, PreferredScoutOption>();
  for (const scout of [...saved, ...history]) unique.set(scout.id, { id: scout.id, firstName: scout.firstName?.trim() || "Preferred Scout", completedMissions: scout.completedMissions });
  return [...unique.values()];
}

function validUuid(value?: string): value is string {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

async function loadRecurrenceOccurrence(db: ReturnType<typeof getDb>, customerId: string, templateId: string, recurrenceId: string, occurrenceValue?: string) {
  const [recurrence] = await db.select().from(missionRecurrences).where(and(
    eq(missionRecurrences.id, recurrenceId),
    eq(missionRecurrences.customerId, customerId),
    eq(missionRecurrences.templateId, templateId),
  )).limit(1);
  if (!recurrence) return null;
  const scheduleOccurrences = [recurrence.lastRunAt, recurrence.nextRunAt].filter((candidate): candidate is Date => Boolean(candidate));
  const requestedOccurrence = occurrenceValue ? new Date(occurrenceValue) : null;
  if (requestedOccurrence && Number.isNaN(requestedOccurrence.getTime())) return null;
  if (requestedOccurrence && !scheduleOccurrences.some((candidate) => candidate.getTime() === requestedOccurrence.getTime())) return null;
  const candidates = requestedOccurrence
    ? [requestedOccurrence]
    : scheduleOccurrences.filter((candidate, index, all) => all.findIndex((item) => item.getTime() === candidate.getTime()) === index);
  for (const occurrenceAt of candidates) {
    const [existing] = await db.select({ id: missions.id }).from(missions).where(and(
      eq(missions.customerId, customerId),
      eq(missions.recurrenceId, recurrence.id),
      eq(missions.recurrenceOccurrenceAt, occurrenceAt),
    )).limit(1);
    if (!existing) return { recurrenceId: recurrence.id, occurrenceAt, timeZone: recurrence.timezone };
  }
  return null;
}

function deliveryMethodFromInstructions(instructions: string | null, pinRequired: boolean): MissionInput["deliveryMethod"] {
  return pinRequired || instructions?.startsWith("Delivery method: Hand directly") ? "hand_to_recipient" : "leave_at_location";
}

function stripDeliveryMethodLine(instructions: string | null) {
  return (instructions ?? "").replace(/^Delivery method: (?:Hand directly to the recipient|Leave at the customer-approved location)\.\s*/i, "").trim();
}
