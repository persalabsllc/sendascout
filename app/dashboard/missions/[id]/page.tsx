import { and, asc, eq, or, isNotNull } from "drizzle-orm";
import { notFound } from "next/navigation";
import { MissionWorkspace } from "@/components/mission-workspace";
import { getDb } from "@/db";
import { missionMessages, missions, missionUpdates, scoutProfiles, users } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";
import { isMissionEligibleForScout } from "@/lib/scout-matching";

export const metadata = { title: "Mission | Send a Scout", robots: { index: false, follow: false } };

export default async function MissionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireAppUser("customer");
  const db = getDb();
  const [mission] = await db.select().from(missions).where(eq(missions.id, id)).limit(1);
  if (!mission) notFound();

  let role: "customer" | "scout" | "admin";
  let canClaim = false;
  if (mission.customerId === user.id) role = "customer";
  else if (mission.scoutId === user.id) role = "scout";
  else if (user.role === "admin") role = "admin";
  else if (user.role === "scout" && mission.status === "open" && !mission.scoutId) {
    const [profile] = await db.select().from(scoutProfiles).where(eq(scoutProfiles.userId, user.id)).limit(1);
    if (!profile || profile.status !== "approved" || !isMissionEligibleForScout(mission, profile)) notFound();
    role = "scout";
    canClaim = true;
  } else notFound();

  const [[customer], scoutRows, messageRows, resultRows] = await Promise.all([
    db.select().from(users).where(eq(users.id, mission.customerId)).limit(1),
    mission.scoutId ? db.select().from(users).where(eq(users.id, mission.scoutId)).limit(1) : Promise.resolve([]),
    mission.scoutId || role === "admin"
      ? db.select({ id: missionMessages.id, body: missionMessages.body, senderId: missionMessages.senderId, createdAt: missionMessages.createdAt })
          .from(missionMessages).where(eq(missionMessages.missionId, mission.id)).orderBy(asc(missionMessages.createdAt))
      : Promise.resolve([]),
    db.select({ id: missionUpdates.id, message: missionUpdates.message, mediaUrl: missionUpdates.mediaUrl, createdAt: missionUpdates.createdAt })
      .from(missionUpdates)
      .where(and(eq(missionUpdates.missionId, mission.id), or(eq(missionUpdates.status, "submitted"), isNotNull(missionUpdates.mediaUrl))))
      .orderBy(asc(missionUpdates.createdAt)),
  ]);
  const scout = scoutRows[0];
  const showFullAddress = role !== "scout" || mission.scoutId === user.id;
  const pickup = showFullAddress
    ? formatLocation(mission.pickupName, mission.addressLine1, mission.addressLine2, mission.city, mission.state, mission.zip)
    : `${mission.city}, ${mission.state} ${mission.zip}`;
  const dropoff = mission.type === "move" && showFullAddress && mission.dropoffAddressLine1
    ? formatLocation(mission.dropoffName, mission.dropoffAddressLine1, mission.dropoffAddressLine2, mission.dropoffCity, mission.dropoffState, mission.dropoffZip)
    : null;
  const latitude = mission.locationSharingActive && mission.scoutLatitude ? Math.round(Number(mission.scoutLatitude) * 1000) / 1000 : null;
  const longitude = mission.locationSharingActive && mission.scoutLongitude ? Math.round(Number(mission.scoutLongitude) * 1000) / 1000 : null;

  return <MissionWorkspace
    role={role}
    canClaim={canClaim}
    mission={{
      id: mission.id,
      type: mission.type,
      status: mission.status,
      title: mission.title,
      instructions: showFullAddress ? mission.instructions : "Full instructions become available after you claim the mission.",
      pickup,
      pickupInstructions: showFullAddress ? mission.pickupInstructions : null,
      dropoff,
      deliveryInstructions: showFullAddress ? mission.deliveryInstructions : null,
      scheduledFor: mission.scheduledFor?.toISOString() ?? null,
      customerPriceCents: mission.customerPriceCents,
      scoutPayoutCents: mission.scoutPayoutCents,
      largeItem: mission.largeItem,
      routeDistanceMeters: mission.routeDistanceMeters,
      routeDurationSeconds: mission.routeDurationSeconds,
      routeSource: mission.routeSource,
      meetAuthorizedMinutes: mission.meetAuthorizedMinutes,
      maximumCustomerPriceCents: mission.maximumCustomerPriceCents,
      maximumScoutPayoutCents: mission.maximumScoutPayoutCents,
      billableStartedAt: mission.billableStartedAt?.toISOString() ?? null,
      billableEndedAt: mission.billableEndedAt?.toISOString() ?? null,
      billableMinutes: mission.billableMinutes,
      chargedMinutes: mission.chargedMinutes,
      verifiedCheckInAt: mission.verifiedCheckInAt?.toISOString() ?? null,
      verifiedCheckOutAt: mission.verifiedCheckOutAt?.toISOString() ?? null,
      locationSharingActive: mission.locationSharingActive,
      latitude,
      longitude,
      locationUpdatedAt: mission.scoutLocationUpdatedAt?.toISOString() ?? null,
      customerName: customer?.firstName || "Customer",
      scoutName: scout?.firstName || null,
    }}
    messages={messageRows.map((message) => ({
      id: message.id,
      body: message.body,
      mine: message.senderId === user.id,
      sender: message.senderId === mission.customerId ? (role === "customer" ? "You" : customer?.firstName || "Customer") : message.senderId === mission.scoutId ? (role === "scout" ? "You" : scout?.firstName || "Your Scout") : "Send a Scout support",
      createdAt: message.createdAt.toISOString(),
    }))}
    results={{
      summary: resultRows.find((item) => item.message)?.message ?? null,
      mediaUrls: resultRows.flatMap((item) => item.mediaUrl ? [privateMediaUrl(mission.id, item.mediaUrl)] : []),
      submittedAt: resultRows[0]?.createdAt.toISOString() ?? null,
    }}
  />;
}

function privateMediaUrl(missionId: string, pathname: string) {
  return `/api/mission-results/media?missionId=${encodeURIComponent(missionId)}&pathname=${encodeURIComponent(pathname)}`;
}

function formatLocation(name: string | null, line1: string, line2: string | null, city: string | null, state: string | null, zip: string | null) {
  return [name, line1, line2, [city, state, zip].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
}
