"use server";

import { and, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { missionMessages, missions, missionUpdates, notifications, scoutProfiles } from "@/db/schema";
import { requireAdminUser, requireAppUser } from "@/lib/app-user";
import { alertEligibleScouts } from "@/lib/notifications";
import { isMissionEligibleForScout } from "@/lib/scout-matching";
import { calculateMissionQuote, meetPriceForMinutes } from "@/lib/mission-pricing";
import { geographicDistanceMeters, verifyScoutAtLocation } from "@/lib/mission-verification";

type MissionStatus = typeof missions.$inferSelect.status;
type Result = { ok: true } | { ok: false; error: string };

const activeStatuses: MissionStatus[] = [
  "claimed", "en_route", "onsite", "en_route_pickup", "at_pickup", "en_route_dropoff", "at_dropoff", "submitted",
];

function refreshMission(id: string) {
  revalidatePath(`/dashboard/missions/${id}`);
  revalidatePath("/dashboard/customer");
  revalidatePath("/dashboard/scout");
  revalidatePath("/control-room");
}

async function getMission(id: string) {
  const [mission] = await getDb().select().from(missions).where(eq(missions.id, id)).limit(1);
  if (!mission) throw new Error("Mission not found.");
  return mission;
}

export async function claimMission(id: string): Promise<Result> {
  try {
    const user = await requireAppUser("scout");
    const db = getDb();
    const [profile] = await db.select().from(scoutProfiles).where(eq(scoutProfiles.userId, user.id)).limit(1);
    if (!profile || profile.status !== "approved") throw new Error("Your Scout account must be approved before claiming missions.");
    const mission = await getMission(id);
    if (!isMissionEligibleForScout(mission, profile)) {
      throw new Error("This mission is outside your selected service area or mission preferences.");
    }
    const [claimed] = await db.update(missions).set({
      scoutId: user.id,
      status: "claimed",
      claimedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(missions.id, id), eq(missions.status, "open"), isNull(missions.scoutId))).returning({ id: missions.id });
    if (!claimed) throw new Error("Another Scout claimed this mission first.");
    await db.insert(missionUpdates).values({ missionId: id, authorId: user.id, status: "claimed", message: "A Scout claimed this mission." });
    const claimedMission = await getMission(id);
    await db.insert(notifications).values({
      recipientUserId: claimedMission.customerId,
      missionId: id,
      channel: "in_app",
      status: "sent",
      kind: "mission_claimed",
      title: "Your mission has a Scout",
      body: "A Scout accepted your mission. Open it to follow progress and send a private message.",
      sentAt: new Date(),
    });
    refreshMission(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to claim this mission." };
  }
}

export async function updateMissionStatus(id: string, nextStatus: MissionStatus): Promise<Result> {
  try {
    const user = await requireAppUser("scout");
    const mission = await getMission(id);
    if (mission.scoutId !== user.id) throw new Error("Only the assigned Scout can update this mission.");
    const transitions: Record<string, MissionStatus[]> = mission.type === "move"
      ? {
          claimed: ["en_route_pickup"],
          en_route_pickup: ["at_pickup"],
          at_pickup: ["en_route_dropoff"],
          en_route_dropoff: ["at_dropoff"],
        }
      : {
          claimed: ["en_route"],
          en_route: ["onsite"],
        };
    if (!transitions[mission.status]?.includes(nextStatus)) throw new Error("That status change is not available yet.");

    const terminal = nextStatus === "submitted";
    const now = new Date();
    let verifiedArrival: ReturnType<typeof verifyScoutAtLocation> | null = null;
    if (nextStatus === "at_pickup" && mission.pickupLatitude && mission.pickupLongitude) verifiedArrival = verifyScoutAtLocation(mission, mission.pickupLatitude, mission.pickupLongitude);
    if (nextStatus === "at_dropoff" && mission.dropoffLatitude && mission.dropoffLongitude) verifiedArrival = verifyScoutAtLocation(mission, mission.dropoffLatitude, mission.dropoffLongitude);
    if (nextStatus === "onsite" && mission.pickupLatitude && mission.pickupLongitude) {
      if (mission.type === "meet") {
        if (!mission.scheduledFor) throw new Error("This appointment does not have a scheduled start time.");
        if (now < mission.scheduledFor) throw new Error(`Billable time cannot begin before ${mission.scheduledFor.toLocaleString()}.`);
      }
      verifiedArrival = verifyScoutAtLocation(mission, mission.pickupLatitude, mission.pickupLongitude);
    }
    await getDb().update(missions).set({
      status: nextStatus,
      billableStartedAt: mission.type === "meet" && nextStatus === "onsite" && verifiedArrival ? now : mission.billableStartedAt,
      billableLastVerifiedAt: mission.type === "meet" && nextStatus === "onsite" && verifiedArrival ? now : mission.billableLastVerifiedAt,
      verifiedCheckInAt: verifiedArrival && ["at_pickup", "onsite"].includes(nextStatus) ? now : mission.verifiedCheckInAt,
      verifiedCheckInLatitude: verifiedArrival && ["at_pickup", "onsite"].includes(nextStatus) ? verifiedArrival.latitude : mission.verifiedCheckInLatitude,
      verifiedCheckInLongitude: verifiedArrival && ["at_pickup", "onsite"].includes(nextStatus) ? verifiedArrival.longitude : mission.verifiedCheckInLongitude,
      verifiedCheckInAccuracyMeters: verifiedArrival && ["at_pickup", "onsite"].includes(nextStatus) ? verifiedArrival.accuracy : mission.verifiedCheckInAccuracyMeters,
      verifiedCheckOutAt: verifiedArrival && nextStatus === "at_dropoff" ? now : mission.verifiedCheckOutAt,
      verifiedCheckOutLatitude: verifiedArrival && nextStatus === "at_dropoff" ? verifiedArrival.latitude : mission.verifiedCheckOutLatitude,
      verifiedCheckOutLongitude: verifiedArrival && nextStatus === "at_dropoff" ? verifiedArrival.longitude : mission.verifiedCheckOutLongitude,
      verifiedCheckOutAccuracyMeters: verifiedArrival && nextStatus === "at_dropoff" ? verifiedArrival.accuracy : mission.verifiedCheckOutAccuracyMeters,
      locationSharingActive: terminal ? false : mission.locationSharingActive,
      scoutLatitude: terminal ? null : mission.scoutLatitude,
      scoutLongitude: terminal ? null : mission.scoutLongitude,
      scoutLocationAccuracyMeters: terminal ? null : mission.scoutLocationAccuracyMeters,
      scoutLocationUpdatedAt: terminal ? null : mission.scoutLocationUpdatedAt,
      updatedAt: new Date(),
    }).where(eq(missions.id, id));
    await getDb().insert(missionUpdates).values({ missionId: id, authorId: user.id, status: nextStatus });
    await getDb().insert(notifications).values({
      recipientUserId: mission.customerId,
      missionId: id,
      channel: "in_app",
      status: "sent",
      kind: "status_update",
      title: "Mission status updated",
      body: statusLabel(mission.type, nextStatus),
      sentAt: new Date(),
    });
    refreshMission(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to update this mission." };
  }
}

export async function submitMissionResults(id: string, summary: string, mediaUrls: string[]): Promise<Result> {
  try {
    const user = await requireAppUser("scout");
    const mission = await getMission(id);
    if (mission.scoutId !== user.id) throw new Error("Only the assigned Scout can submit results.");
    const ready = mission.type === "move" ? mission.status === "at_dropoff" : mission.status === "onsite";
    if (!ready) throw new Error("Finish the mission steps before submitting results.");

    const cleanSummary = summary.trim();
    const mediaPrefix = `mission-results/${id}/`;
    const cleanUrls = [...new Set(mediaUrls
      .map((url) => url.trim())
      .filter((url) => url.startsWith(mediaPrefix) && !url.includes("..")))]
      .slice(0, 12);
    if (!cleanSummary && cleanUrls.length === 0) throw new Error("Add a written result, photo, or video before submitting.");
    if (cleanSummary.length > 5000) throw new Error("Result notes are limited to 5,000 characters.");

    const db = getDb();
    const now = new Date();
    let billingChanges: Partial<typeof missions.$inferInsert> = {};
    if (mission.type === "meet" && mission.pickupLatitude && mission.pickupLongitude) {
      if (!mission.billableStartedAt) throw new Error("Verified appointment time has not started.");
      const lastVerifiedAt = mission.billableLastVerifiedAt ?? mission.billableStartedAt;
      const verifiedEndMs = Math.min(
        now.getTime(),
        lastVerifiedAt.getTime() + 60_000,
        mission.billableStartedAt.getTime() + mission.meetAuthorizedMinutes * 60_000,
      );
      const billableMinutes = Math.max(1, Math.ceil((verifiedEndMs - mission.billableStartedAt.getTime()) / 60_000));
      const chargedMinutes = Math.min(mission.meetAuthorizedMinutes, Math.max(60, Math.ceil(billableMinutes / 15) * 15));
      const finalPrice = meetPriceForMinutes(chargedMinutes);
      billingChanges = {
        billableEndedAt: new Date(verifiedEndMs),
        billableMinutes,
        chargedMinutes,
        customerPriceCents: finalPrice.customer,
        scoutPayoutCents: finalPrice.scout,
        platformFeeCents: finalPrice.customer - finalPrice.scout,
        verifiedCheckOutAt: new Date(verifiedEndMs),
      };
    }
    const resultUpdate = db.insert(missionUpdates).values({
        missionId: id,
        authorId: user.id,
        status: "submitted",
        message: cleanSummary || "Scout submitted mission media.",
      });
    const mediaUpdate = cleanUrls.length
      ? db.insert(missionUpdates).values(cleanUrls.map((mediaUrl) => ({
          missionId: id,
          authorId: user.id,
          status: "submitted" as const,
          mediaUrl,
        })))
      : null;
    const missionUpdate = db.update(missions).set({
        ...billingChanges,
        status: "submitted",
        locationSharingActive: false,
        scoutLatitude: null,
        scoutLongitude: null,
        scoutLocationAccuracyMeters: null,
        scoutLocationUpdatedAt: null,
        updatedAt: new Date(),
      }).where(eq(missions.id, id));
    const customerNotification = db.insert(notifications).values({
        recipientUserId: mission.customerId,
        missionId: id,
        channel: "in_app",
        status: "sent",
        kind: "results_submitted",
        title: mission.type === "move" ? "Delivery results are ready" : "Mission results are ready",
        body: "Your Scout submitted notes and media for your review.",
        sentAt: new Date(),
      });
    if (mediaUpdate) await db.batch([resultUpdate, mediaUpdate, missionUpdate, customerNotification]);
    else await db.batch([resultUpdate, missionUpdate, customerNotification]);
    refreshMission(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to submit mission results." };
  }
}

export async function setLocationSharing(id: string, active: boolean): Promise<Result> {
  try {
    const user = await requireAppUser("scout");
    const mission = await getMission(id);
    if (mission.scoutId !== user.id || !activeStatuses.includes(mission.status)) throw new Error("Location sharing is available only on your active mission.");
    await getDb().update(missions).set({
      locationSharingActive: active,
      scoutLatitude: active ? mission.scoutLatitude : null,
      scoutLongitude: active ? mission.scoutLongitude : null,
      scoutLocationAccuracyMeters: active ? mission.scoutLocationAccuracyMeters : null,
      scoutLocationUpdatedAt: active ? mission.scoutLocationUpdatedAt : null,
      updatedAt: new Date(),
    }).where(eq(missions.id, id));
    refreshMission(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to change location sharing." };
  }
}

export async function updateMissionLocation(id: string, latitude: number, longitude: number, accuracy: number): Promise<Result> {
  try {
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new Error("Invalid location.");
    const user = await requireAppUser("scout");
    const mission = await getMission(id);
    if (mission.scoutId !== user.id || !mission.locationSharingActive || !activeStatuses.includes(mission.status)) throw new Error("Location sharing is not active.");
    const now = new Date();
    const normalizedAccuracy = Math.max(0, Math.min(10000, Math.round(accuracy || 0)));
    const verifiedOnsite = mission.type === "meet" && mission.status === "onsite" && mission.pickupLatitude && mission.pickupLongitude && normalizedAccuracy <= 200 && geographicDistanceMeters(latitude, longitude, Number(mission.pickupLatitude), Number(mission.pickupLongitude)) <= 250;
    await getDb().update(missions).set({
      scoutLatitude: latitude.toFixed(6),
      scoutLongitude: longitude.toFixed(6),
      scoutLocationAccuracyMeters: normalizedAccuracy,
      scoutLocationUpdatedAt: now,
      billableLastVerifiedAt: verifiedOnsite ? now : mission.billableLastVerifiedAt,
      updatedAt: now,
    }).where(eq(missions.id, id));
    revalidatePath(`/dashboard/missions/${id}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to share location." };
  }
}

export async function approveMeetExtension(id: string): Promise<Result> {
  try {
    const user = await requireAppUser("customer");
    const mission = await getMission(id);
    if (mission.customerId !== user.id || mission.type !== "meet" || mission.status !== "onsite") throw new Error("This appointment cannot be extended right now.");
    if (mission.meetAuthorizedMinutes >= 480) throw new Error("The maximum appointment authorization is eight hours.");
    const authorizedMinutes = mission.meetAuthorizedMinutes + 60;
    const maximum = meetPriceForMinutes(authorizedMinutes);
    const db = getDb();
    await db.update(missions).set({
      meetAuthorizedMinutes: authorizedMinutes,
      maximumCustomerPriceCents: maximum.customer,
      maximumScoutPayoutCents: maximum.scout,
      updatedAt: new Date(),
    }).where(eq(missions.id, id));
    if (mission.scoutId) await db.insert(notifications).values({
      recipientUserId: mission.scoutId,
      missionId: id,
      channel: "in_app",
      status: "sent",
      kind: "appointment_extended",
      title: "Customer approved more appointment time",
      body: `The verified appointment limit is now ${authorizedMinutes / 60} hours.`,
      sentAt: new Date(),
    });
    refreshMission(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to extend this appointment." };
  }
}

export async function sendMissionMessage(id: string, body: string): Promise<Result> {
  try {
    const user = await requireAppUser("customer");
    const mission = await getMission(id);
    const participant = user.role === "admin" || mission.customerId === user.id || mission.scoutId === user.id;
    if (!participant || !mission.scoutId) throw new Error("Messaging opens after a Scout accepts the mission.");
    const cleanBody = body.trim();
    if (!cleanBody) throw new Error("Write a message first.");
    if (cleanBody.length > 1500) throw new Error("Messages are limited to 1,500 characters.");
    await getDb().insert(missionMessages).values({ missionId: id, senderId: user.id, body: cleanBody });
    const recipientUserId = user.id === mission.customerId ? mission.scoutId : mission.customerId;
    await getDb().insert(notifications).values({
      recipientUserId,
      missionId: id,
      channel: "in_app",
      status: "sent",
      kind: "new_message",
      title: "New mission message",
      body: "You received a private message in Send a Scout.",
      sentAt: new Date(),
    });
    refreshMission(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to send the message." };
  }
}

export async function confirmMissionComplete(id: string): Promise<Result> {
  try {
    const user = await requireAppUser("customer");
    const mission = await getMission(id);
    if (mission.customerId !== user.id || mission.status !== "submitted") throw new Error("This mission is not ready for confirmation.");
    const db = getDb();
    const missionUpdate = db.update(missions).set({ status: "completed", completedAt: new Date(), locationSharingActive: false, scoutLatitude: null, scoutLongitude: null, scoutLocationAccuracyMeters: null, scoutLocationUpdatedAt: null, updatedAt: new Date() }).where(eq(missions.id, id));
    const completionUpdate = db.insert(missionUpdates).values({ missionId: id, authorId: user.id, status: "completed", message: "Customer confirmed completion." });
    if (mission.scoutId) {
      const scoutUpdate = db.update(scoutProfiles).set({
          completedMissions: sql`${scoutProfiles.completedMissions} + 1`,
          updatedAt: new Date(),
        }).where(eq(scoutProfiles.userId, mission.scoutId));
      await db.batch([missionUpdate, completionUpdate, scoutUpdate]);
    } else await db.batch([missionUpdate, completionUpdate]);
    refreshMission(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to complete the mission." };
  }
}

export async function adminSetScoutStatus(profileId: string, status: "review" | "approved" | "paused" | "rejected"): Promise<Result> {
  try {
    await requireAdminUser();
    await getDb().update(scoutProfiles).set({
      status,
      approvedAt: status === "approved" ? new Date() : null,
      updatedAt: new Date(),
    }).where(eq(scoutProfiles.id, profileId));
    revalidatePath("/control-room");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to update the Scout." };
  }
}

export async function adminSetMissionStatus(id: string, status: "draft" | "open" | "cancelled" | "completed"): Promise<Result> {
  try {
    const admin = await requireAdminUser();
    const mission = await getMission(id);
    if (status === "open" && mission.status !== "draft") throw new Error("Only draft missions can be opened.");
    if (status === "draft" && (mission.status !== "open" || mission.scoutId)) throw new Error("Only unclaimed open missions can be pulled from Scouts.");
    const verifiedQuote = status === "open" ? await calculateMissionQuote({
      type: mission.type,
      address: mission.addressLine1,
      addressLine2: mission.addressLine2 ?? "",
      city: mission.city,
      zip: mission.zip,
      pickupAddress: mission.addressLine1,
      pickupAddressLine2: mission.addressLine2 ?? "",
      pickupCity: mission.city,
      pickupState: mission.state,
      pickupZip: mission.zip,
      dropoffAddress: mission.dropoffAddressLine1 ?? "",
      dropoffAddressLine2: mission.dropoffAddressLine2 ?? "",
      dropoffCity: mission.dropoffCity ?? "",
      dropoffState: mission.dropoffState ?? "",
      dropoffZip: mission.dropoffZip ?? "",
      largeItem: mission.largeItem,
      meetAuthorizedMinutes: mission.meetAuthorizedMinutes,
    }) : null;
    if (status === "open" && mission.type === "move" && verifiedQuote?.routeSource !== "google") throw new Error("Connect Google route verification before releasing Move It missions.");
    if (status === "open" && mission.type === "meet" && !verifiedQuote?.pickupCoordinates) throw new Error("Connect Google address verification before releasing Meet It missions.");
    await getDb().update(missions).set({
      status,
      ...(verifiedQuote ? {
        customerPriceCents: verifiedQuote.customerPriceCents,
        scoutPayoutCents: verifiedQuote.scoutPayoutCents,
        platformFeeCents: verifiedQuote.platformFeeCents,
        maximumCustomerPriceCents: verifiedQuote.maximumCustomerPriceCents,
        maximumScoutPayoutCents: verifiedQuote.maximumScoutPayoutCents,
        pickupLatitude: verifiedQuote.pickupCoordinates?.latitude.toFixed(6) ?? null,
        pickupLongitude: verifiedQuote.pickupCoordinates?.longitude.toFixed(6) ?? null,
        dropoffLatitude: verifiedQuote.dropoffCoordinates?.latitude.toFixed(6) ?? null,
        dropoffLongitude: verifiedQuote.dropoffCoordinates?.longitude.toFixed(6) ?? null,
        routeDistanceMeters: verifiedQuote.routeDistanceMeters,
        routeDurationSeconds: verifiedQuote.routeDurationSeconds,
        routePolyline: verifiedQuote.routePolyline,
        routeSource: verifiedQuote.routeSource,
        routeQuotedAt: verifiedQuote.routeSource === "google" ? new Date() : null,
      } : {}),
      completedAt: status === "completed" ? new Date() : mission.completedAt,
      locationSharingActive: false,
      scoutLatitude: null,
      scoutLongitude: null,
      scoutLocationAccuracyMeters: null,
      scoutLocationUpdatedAt: null,
      updatedAt: new Date(),
    }).where(eq(missions.id, id));
    await getDb().insert(missionUpdates).values({ missionId: id, authorId: admin.id, status, message: status === "draft" ? "Control Room pulled this mission from the Scout board." : `Control Room changed mission to ${status}.` });
    if (status === "draft") await getDb().update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.missionId, id), eq(notifications.kind, "new_mission")));
    if (status === "open") await alertEligibleScouts(id);
    refreshMission(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to update the mission." };
  }
}

export async function markNotificationRead(id: string): Promise<void> {
  const user = await requireAppUser("customer");
  await getDb().update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.id, id), eq(notifications.recipientUserId, user.id)));
  revalidatePath("/dashboard/customer");
  revalidatePath("/dashboard/scout");
}

function statusLabel(type: "see" | "move" | "meet", status: MissionStatus) {
  if (type === "move") {
    const labels: Partial<Record<MissionStatus, string>> = {
      claimed: "Your Scout accepted the delivery.",
      en_route_pickup: "Your Scout is en route to the pickup.",
      at_pickup: "Your Scout is at the pickup location.",
      en_route_dropoff: "Your Scout is on the way to the drop-off.",
      at_dropoff: "Your Scout arrived at the drop-off.",
      submitted: "Your Scout marked the delivery complete.",
    };
    return labels[status] ?? `Mission status: ${status}`;
  }
  const noun = type === "see" ? "inspection" : "appointment";
  const labels: Partial<Record<MissionStatus, string>> = {
    claimed: `Your Scout accepted the ${noun}.`,
    en_route: `Your Scout is en route to the ${noun}.`,
    onsite: type === "meet" ? "Your Scout checked in onsite. Verified appointment time has started." : `Your Scout is at the ${noun} location.`,
    submitted: `Your Scout submitted the ${noun} results.`,
  };
  return labels[status] ?? `Mission status: ${status}`;
}
