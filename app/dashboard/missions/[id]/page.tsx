import { and, asc, eq, inArray, or, isNotNull, isNull, sql } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { MissionWorkspace } from "@/components/mission-workspace";
import { getDb } from "@/db";
import {
  customerPreferredScouts,
  missionBundles,
  missionChangeOrders,
  missionChecklistItems,
  missionEvidence,
  missionMessages,
  missionPartResults,
  missionReviews,
  missions,
  missionUpdates,
  scoutProfiles,
  users,
} from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";
import { isMissionEligibleForScout } from "@/lib/scout-matching";
import { hasCurrentScoutHandbookAcceptance } from "@/lib/scout-handbook";
import { scoutConnectReady } from "@/lib/stripe-connect";
import { getStripeLivemode } from "@/lib/stripe";

export const metadata = { title: "Mission | Send a Scout", robots: { index: false, follow: false } };

export default async function MissionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireAppUser("customer");
  const db = getDb();
  const [mission] = await db.select().from(missions).where(eq(missions.id, id)).limit(1);
  if (!mission) notFound();
  const [bundleRows, itineraryRows] = await Promise.all([
    mission.bundleId ? db.select().from(missionBundles).where(eq(missionBundles.id, mission.bundleId)).limit(1) : Promise.resolve([]),
    mission.bundleId
      ? db.select().from(missions).where(and(eq(missions.bundleId, mission.bundleId), isNull(missions.archivedAt))).orderBy(asc(missions.bundleSequence))
      : Promise.resolve([]),
  ]);
  const bundle = bundleRows[0] ?? null;
  const itinerary = itineraryRows.length ? itineraryRows : [mission];

  let role: "customer" | "scout" | "admin";
  let canClaim = false;
  if (mission.customerId === user.id) role = "customer";
  else if (mission.scoutId === user.id) role = "scout";
  else if (user.role === "admin") role = "admin";
  else if (user.role === "scout" && mission.status === "open" && mission.paymentStatus === "paid" && (!bundle || bundle.paymentStatus === "paid") && !mission.scoutId) {
    const [[profile], claimWindows] = await Promise.all([
      db.select().from(scoutProfiles).where(eq(scoutProfiles.userId, user.id)).limit(1),
      db.select({ available: sql<boolean>`(
        ${missions.preferredScoutId} IS NULL
        OR ${missions.preferredScoutId} = ${user.id}
        OR ${missions.preferredScoutBroadcastAt} IS NOT NULL
        OR ${missions.preferredScoutExclusiveUntil} IS NULL
        OR ${missions.preferredScoutExclusiveUntil} <= now()
      )` }).from(missions).where(inArray(missions.id, itinerary.map((leg) => leg.id))),
    ]);
    if (!profile || profile.status !== "approved" || !scoutConnectReady(profile, getStripeLivemode()) || itinerary.some((leg) => leg.paymentStatus !== "paid") || claimWindows.length !== itinerary.length || claimWindows.some((window) => !window.available) || itinerary.some((leg) => !isMissionEligibleForScout(leg, profile))) notFound();
    if (!hasCurrentScoutHandbookAcceptance(profile)) {
      const currentPath = `/dashboard/missions/${encodeURIComponent(id)}`;
      redirect(`/dashboard/scout/handbook?next=${encodeURIComponent(currentPath)}`);
    }
    role = "scout";
    canClaim = true;
  } else notFound();
  const finalLeg = itinerary.at(-1) ?? mission;
  const reviewMissionId = finalLeg.id;

  const [[customer], scoutRows, assignedProfileRows, messageRows, resultRows, partResultRows, reviewRows, checklistRows, evidenceRows, changeOrderRows, preferredScoutRows] = await Promise.all([
    db.select().from(users).where(eq(users.id, mission.customerId)).limit(1),
    mission.scoutId ? db.select().from(users).where(eq(users.id, mission.scoutId)).limit(1) : Promise.resolve([]),
    mission.scoutId ? db.select({ headshotPath: scoutProfiles.headshotPath, rating: scoutProfiles.rating, ratingCount: scoutProfiles.ratingCount, identityCheck: scoutProfiles.identityCheck, identityVerifiedName: scoutProfiles.identityVerifiedName, completedMissions: scoutProfiles.completedMissions }).from(scoutProfiles).where(eq(scoutProfiles.userId, mission.scoutId)).limit(1) : Promise.resolve([]),
    mission.scoutId || role === "admin"
      ? db.select({ id: missionMessages.id, body: missionMessages.body, senderId: missionMessages.senderId, createdAt: missionMessages.createdAt })
          .from(missionMessages).where(eq(missionMessages.missionId, mission.id)).orderBy(asc(missionMessages.createdAt))
      : Promise.resolve([]),
    db.select({ id: missionUpdates.id, message: missionUpdates.message, mediaUrl: missionUpdates.mediaUrl, createdAt: missionUpdates.createdAt })
      .from(missionUpdates)
      .where(and(eq(missionUpdates.missionId, mission.id), or(eq(missionUpdates.status, "submitted"), isNotNull(missionUpdates.mediaUrl))))
      .orderBy(asc(missionUpdates.createdAt)),
    db.select({ summary: missionPartResults.summary, submittedAt: missionPartResults.submittedAt }).from(missionPartResults).where(eq(missionPartResults.missionId, mission.id)).limit(1),
    db.select({ rating: missionReviews.rating, review: missionReviews.review, tipCents: missionReviews.tipCents }).from(missionReviews).where(eq(missionReviews.missionId, reviewMissionId)).limit(1),
    db.select().from(missionChecklistItems).where(eq(missionChecklistItems.missionId, mission.id)).orderBy(asc(missionChecklistItems.sequence)),
    db.select().from(missionEvidence).where(eq(missionEvidence.missionId, mission.id)).orderBy(asc(missionEvidence.createdAt)),
    db.select().from(missionChangeOrders).where(eq(missionChangeOrders.missionId, mission.id)).orderBy(asc(missionChangeOrders.createdAt)),
    mission.scoutId ? db.select({ id: customerPreferredScouts.id }).from(customerPreferredScouts).where(and(eq(customerPreferredScouts.customerId, mission.customerId), eq(customerPreferredScouts.scoutId, mission.scoutId))).limit(1) : Promise.resolve([]),
  ]);
  const scout = scoutRows[0];
  const assignedProfile = assignedProfileRows[0];
  const showFullAddress = role !== "scout" || mission.scoutId === user.id;
  const pickup = showFullAddress
    ? formatLocation(mission.pickupName, mission.addressLine1, mission.addressLine2, mission.city, mission.state, mission.zip)
    : `${mission.city}, ${mission.state} ${mission.zip}`;
  const dropoff = mission.type === "move" && showFullAddress && mission.dropoffAddressLine1
    ? formatLocation(mission.dropoffName, mission.dropoffAddressLine1, mission.dropoffAddressLine2, mission.dropoffCity, mission.dropoffState, mission.dropoffZip)
    : null;
  const latitude = mission.locationSharingActive && mission.scoutLatitude ? Math.round(Number(mission.scoutLatitude) * 1000) / 1000 : null;
  const longitude = mission.locationSharingActive && mission.scoutLongitude ? Math.round(Number(mission.scoutLongitude) * 1000) / 1000 : null;
  const mapPrecision = role === "scout" && mission.scoutId !== user.id ? 3 : 6;
  const mapCoordinate = (value: string | null) => value === null ? null : Number(Number(value).toFixed(mapPrecision));
  const pickupMapLatitude = mapCoordinate(mission.pickupLatitude);
  const pickupMapLongitude = mapCoordinate(mission.pickupLongitude);
  const dropoffMapLatitude = mapCoordinate(mission.dropoffLatitude);
  const dropoffMapLongitude = mapCoordinate(mission.dropoffLongitude);
  const semanticEvidencePaths = new Set(evidenceRows.map((item) => item.storagePath));
  const accessibleEvidenceRows = role === "customer" ? evidenceRows.filter((item) => item.customerVisible) : evidenceRows;
  const deliveryProofRows = accessibleEvidenceRows.filter((item) => item.kind === "delivery_photo");
  const isActiveBundleLeg = !bundle || mission.bundleSequence === bundle.activeSequence;
  const isFinalBundleLeg = !bundle || mission.id === finalLeg.id;

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
      timeZone: mission.timezone,
      customerPriceCents: mission.customerPriceCents,
      scoutPayoutCents: mission.scoutPayoutCents,
      claimScoutPayoutCents: bundle?.scoutPayoutCents ?? mission.scoutPayoutCents,
      claimCustomerPriceCents: bundle?.customerPriceCents ?? mission.customerPriceCents,
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
      directionsUrl: mapDirectionsUrl(mission.type, pickupMapLatitude, pickupMapLongitude, dropoffMapLatitude, dropoffMapLongitude),
      customerName: customer?.firstName || "Customer",
      scoutName: mission.scoutDisplayNameSnapshot
        ? mission.scoutDisplayNameSnapshot.trim().split(/\s+/)[0]
        : assignedProfile?.identityCheck === "clear" && assignedProfile.identityVerifiedName
          ? assignedProfile.identityVerifiedName.trim().split(/\s+/)[0]
        : scout?.firstName || null,
      scoutHeadshotUrl: scout && (mission.scoutHeadshotPathSnapshot || assignedProfile?.headshotPath) ? `/api/scout-headshot?missionId=${encodeURIComponent(mission.id)}` : null,
      scoutCompletedMissions: assignedProfile?.completedMissions ?? 0,
      scoutRating: assignedProfile?.rating ? Number(assignedProfile.rating) : null,
      scoutRatingCount: assignedProfile?.ratingCount ?? 0,
      scoutIdentityVerified: Boolean(mission.scoutIdentityVerifiedAtSnapshot) || assignedProfile?.identityCheck === "clear",
      proofOfDeliveryRequired: mission.proofOfDeliveryRequired,
      deliveryPinRequired: mission.deliveryPinRequired,
      deliveryPinVerified: Boolean(mission.deliveryPinVerifiedAt),
      isActiveBundleLeg,
      isFinalBundleLeg,
      bookingCompleted: bundle ? bundle.status === "completed" : mission.status === "completed",
    }}
    bundle={bundle ? {
      id: bundle.id,
      title: bundle.title,
      status: bundle.status,
      activeSequence: bundle.activeSequence,
      totalLegs: itinerary.length,
      listCustomerPriceCents: bundle.listCustomerPriceCents,
      bundleDiscountCents: bundle.bundleDiscountCents,
      customerPriceCents: bundle.customerPriceCents,
      scoutPayoutCents: bundle.scoutPayoutCents,
    } : null}
    itinerary={itinerary.map((leg) => ({
      id: leg.id,
      sequence: leg.bundleSequence ?? 1,
      type: leg.type,
      status: leg.status,
      title: leg.title,
      pickup: showFullAddress
        ? formatLocation(leg.pickupName, leg.addressLine1, leg.addressLine2, leg.city, leg.state, leg.zip)
        : `${leg.city}, ${leg.state} ${leg.zip}`,
      dropoff: leg.type === "move" && leg.dropoffAddressLine1 && showFullAddress
        ? formatLocation(leg.dropoffName, leg.dropoffAddressLine1, leg.dropoffAddressLine2, leg.dropoffCity, leg.dropoffState, leg.dropoffZip)
        : null,
      active: !bundle || leg.bundleSequence === bundle.activeSequence,
      current: leg.id === mission.id,
    }))}
    messages={messageRows.map((message) => ({
      id: message.id,
      body: message.body,
      mine: message.senderId === user.id,
      sender: message.senderId === mission.customerId ? (role === "customer" ? "You" : customer?.firstName || "Customer") : message.senderId === mission.scoutId ? (role === "scout" ? "You" : scout?.firstName || "Your Scout") : "Send a Scout support",
      createdAt: message.createdAt.toISOString(),
    }))}
    results={{
      summary: partResultRows[0]?.summary ?? resultRows.find((item) => item.message)?.message ?? null,
      mediaUrls: [
        ...resultRows.flatMap((item) => item.mediaUrl && !semanticEvidencePaths.has(item.mediaUrl) ? [privateMediaUrl(mission.id, item.mediaUrl)] : []),
        ...accessibleEvidenceRows.filter((item) => item.kind === "general_result").map((item) => privateMediaUrl(mission.id, item.storagePath)),
      ],
      submittedAt: partResultRows[0]?.submittedAt?.toISOString() ?? resultRows[0]?.createdAt.toISOString() ?? null,
    }}
    deliveryProof={{
      mediaUrls: deliveryProofRows.map((item) => privateMediaUrl(mission.id, item.storagePath)),
      submittedAt: deliveryProofRows[0]?.createdAt.toISOString() ?? null,
    }}
    checklist={checklistRows.map((item) => ({
      id: item.id,
      sequence: item.sequence,
      prompt: item.prompt,
      responseType: item.responseType,
      required: item.required,
      responseText: item.responseText,
      mediaUrls: accessibleEvidenceRows.filter((evidence) => evidence.checklistItemId === item.id).map((evidence) => privateMediaUrl(mission.id, evidence.storagePath)),
    }))}
    changeOrders={changeOrderRows.map((order) => ({
      id: order.id,
      status: order.status,
      description: order.description,
      customerDeltaCents: order.customerDeltaCents,
      scoutDeltaCents: order.scoutDeltaCents,
      proposedByMe: order.proposedByUserId === user.id,
      awaitingPayment: order.status === "pending" && Boolean(order.approvedByUserId),
      expiresAt: order.expiresAt?.toISOString() ?? null,
    }))}
    scoutPreferred={Boolean(preferredScoutRows[0])}
    review={reviewRows[0] ?? null}
  />;
}

function privateMediaUrl(missionId: string, pathname: string) {
  return `/api/mission-results/media?missionId=${encodeURIComponent(missionId)}&pathname=${encodeURIComponent(pathname)}`;
}

function formatLocation(name: string | null, line1: string, line2: string | null, city: string | null, state: string | null, zip: string | null) {
  return [name, line1, line2, [city, state, zip].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
}

function mapDirectionsUrl(type: "see" | "move" | "meet", pickupLatitude: number | null, pickupLongitude: number | null, dropoffLatitude: number | null, dropoffLongitude: number | null) {
  if (pickupLatitude === null || pickupLongitude === null) return null;
  const pickup = `${pickupLatitude},${pickupLongitude}`;
  if (type === "move" && dropoffLatitude !== null && dropoffLongitude !== null) {
    return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(pickup)}&destination=${encodeURIComponent(`${dropoffLatitude},${dropoffLongitude}`)}&travelmode=driving`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(pickup)}`;
}
