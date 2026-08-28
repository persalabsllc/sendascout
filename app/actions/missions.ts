"use server";

import { and, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { missionMessages, missions, missionUpdates, notifications, scoutProfiles } from "@/db/schema";
import { requireAdminUser, requireAppUser } from "@/lib/app-user";
import { alertEligibleScouts } from "@/lib/notifications";

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
    const [claimed] = await db.update(missions).set({
      scoutId: user.id,
      status: "claimed",
      claimedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(missions.id, id), eq(missions.status, "open"), isNull(missions.scoutId))).returning({ id: missions.id });
    if (!claimed) throw new Error("Another Scout claimed this mission first.");
    await db.insert(missionUpdates).values({ missionId: id, authorId: user.id, status: "claimed", message: "A Scout claimed this mission." });
    const mission = await getMission(id);
    await db.insert(notifications).values({
      recipientUserId: mission.customerId,
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
    await getDb().update(missions).set({
      status: nextStatus,
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
    const cleanUrls = [...new Set(mediaUrls.map((url) => url.trim()).filter((url) => /^https:\/\//.test(url)))].slice(0, 12);
    if (!cleanSummary && cleanUrls.length === 0) throw new Error("Add a written result, photo, or video before submitting.");
    if (cleanSummary.length > 5000) throw new Error("Result notes are limited to 5,000 characters.");

    const db = getDb();
    await db.transaction(async (tx) => {
      await tx.insert(missionUpdates).values({
        missionId: id,
        authorId: user.id,
        status: "submitted",
        message: cleanSummary || "Scout submitted mission media.",
      });
      if (cleanUrls.length) {
        await tx.insert(missionUpdates).values(cleanUrls.map((mediaUrl) => ({
          missionId: id,
          authorId: user.id,
          status: "submitted" as const,
          mediaUrl,
        })));
      }
      await tx.update(missions).set({
        status: "submitted",
        locationSharingActive: false,
        scoutLatitude: null,
        scoutLongitude: null,
        scoutLocationAccuracyMeters: null,
        scoutLocationUpdatedAt: null,
        updatedAt: new Date(),
      }).where(eq(missions.id, id));
      await tx.insert(notifications).values({
        recipientUserId: mission.customerId,
        missionId: id,
        channel: "in_app",
        status: "sent",
        kind: "results_submitted",
        title: mission.type === "move" ? "Delivery results are ready" : "Mission results are ready",
        body: "Your Scout submitted notes and media for your review.",
        sentAt: new Date(),
      });
    });
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
    await getDb().update(missions).set({
      scoutLatitude: latitude.toFixed(6),
      scoutLongitude: longitude.toFixed(6),
      scoutLocationAccuracyMeters: Math.max(0, Math.min(10000, Math.round(accuracy || 0))),
      scoutLocationUpdatedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(missions.id, id));
    revalidatePath(`/dashboard/missions/${id}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to share location." };
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
    await db.transaction(async (tx) => {
      await tx.update(missions).set({ status: "completed", completedAt: new Date(), locationSharingActive: false, scoutLatitude: null, scoutLongitude: null, scoutLocationAccuracyMeters: null, scoutLocationUpdatedAt: null, updatedAt: new Date() }).where(eq(missions.id, id));
      await tx.insert(missionUpdates).values({ missionId: id, authorId: user.id, status: "completed", message: "Customer confirmed completion." });
      if (mission.scoutId) {
        await tx.update(scoutProfiles).set({
          completedMissions: sql`${scoutProfiles.completedMissions} + 1`,
          updatedAt: new Date(),
        }).where(eq(scoutProfiles.userId, mission.scoutId));
      }
    });
    refreshMission(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to complete the mission." };
  }
}

export async function adminSetScoutStatus(profileId: string, status: "review" | "approved" | "paused" | "rejected"): Promise<Result> {
  try {
    await requireAdminUser();
    await getDb().update(scoutProfiles).set({ status, updatedAt: new Date() }).where(eq(scoutProfiles.id, profileId));
    revalidatePath("/control-room");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to update the Scout." };
  }
}

export async function adminSetMissionStatus(id: string, status: "open" | "cancelled" | "completed"): Promise<Result> {
  try {
    const admin = await requireAdminUser();
    const mission = await getMission(id);
    if (status === "open" && mission.status !== "draft") throw new Error("Only draft missions can be opened.");
    await getDb().update(missions).set({
      status,
      completedAt: status === "completed" ? new Date() : mission.completedAt,
      locationSharingActive: false,
      scoutLatitude: null,
      scoutLongitude: null,
      scoutLocationAccuracyMeters: null,
      scoutLocationUpdatedAt: null,
      updatedAt: new Date(),
    }).where(eq(missions.id, id));
    await getDb().insert(missionUpdates).values({ missionId: id, authorId: admin.id, status, message: `Control Room changed mission to ${status}.` });
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
    onsite: `Your Scout is at the ${noun} location.`,
    submitted: `Your Scout submitted the ${noun} results.`,
  };
  return labels[status] ?? `Mission status: ${status}`;
}
