import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { missionBundles, missions, scoutProfiles } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";
import { computeDrivingRoute } from "@/lib/google-maps";
import { isMissionEligibleForScout } from "@/lib/scout-matching";
import { scoutCanBrowseOpenMissions } from "@/lib/scout-mission-access";

export async function GET(request: Request) {
  const user = await requireAppUser("customer");
  const missionId = new URL(request.url).searchParams.get("missionId");
  if (!missionId) return NextResponse.json({ error: "Mission ID is required." }, { status: 400 });

  const db = getDb();
  const [mission] = await db.select().from(missions).where(eq(missions.id, missionId)).limit(1);
  if (!mission) return NextResponse.json({ error: "Mission not found." }, { status: 404 });
  const [bundle] = mission.bundleId
    ? await db.select({ paymentStatus: missionBundles.paymentStatus }).from(missionBundles).where(eq(missionBundles.id, mission.bundleId)).limit(1)
    : [null];

  let allowed = mission.customerId === user.id || mission.scoutId === user.id || user.role === "admin";
  let planningPrecision = 3;
  if (!allowed && user.role === "scout" && user.status === "active" && mission.status === "open" && mission.paymentStatus === "paid" && (!bundle || bundle.paymentStatus === "paid") && !mission.scoutId) {
    const [[profile], itinerary] = await Promise.all([
      db.select().from(scoutProfiles).where(eq(scoutProfiles.userId, user.id)).limit(1),
      mission.bundleId
        ? db.select().from(missions).where(and(eq(missions.bundleId, mission.bundleId), isNull(missions.archivedAt)))
        : Promise.resolve([mission]),
    ]);
    const privateFirstLook = itinerary.some((leg) => Boolean(
      leg.preferredScoutId
      && leg.preferredScoutId !== user.id
      && !leg.preferredScoutBroadcastAt
      && (!leg.preferredScoutExclusiveUntil || leg.preferredScoutExclusiveUntil.getTime() > Date.now()),
    ));
    allowed = Boolean(
      !privateFirstLook
      && profile
      && scoutCanBrowseOpenMissions(user, profile)
      && itinerary.every((leg) => leg.paymentStatus === "paid" && isMissionEligibleForScout(leg, profile)),
    );
    planningPrecision = profile?.status === "approved" ? 3 : 2;
  }
  if (!allowed) return NextResponse.json({ error: "You cannot view this mission map." }, { status: 403 });

  const key = process.env.GOOGLE_MAPS_SERVER_API_KEY;
  if (!key || !mission.pickupLatitude || !mission.pickupLongitude) return NextResponse.json({ error: "Mission map is unavailable." }, { status: 503 });

  const planningView = user.role === "scout" && mission.scoutId !== user.id;
  const pickup = coordinatePair(mission.pickupLatitude, mission.pickupLongitude, planningView ? planningPrecision : 6);
  const mapUrl = new URL("https://maps.googleapis.com/maps/api/staticmap");
  mapUrl.searchParams.set("size", "900x480");
  mapUrl.searchParams.set("scale", "2");
  mapUrl.searchParams.set("maptype", "roadmap");
  mapUrl.searchParams.set("key", key);

  if (mission.type === "move" && mission.dropoffLatitude && mission.dropoffLongitude) {
    const dropoff = coordinatePair(mission.dropoffLatitude, mission.dropoffLongitude, planningView ? planningPrecision : 6);
    let routePolyline = planningView ? null : mission.routePolyline;
    if (!planningView && !routePolyline) {
      try {
        const route = await computeDrivingRoute(
          { latitude: Number(mission.pickupLatitude), longitude: Number(mission.pickupLongitude) },
          { latitude: Number(mission.dropoffLatitude), longitude: Number(mission.dropoffLongitude) },
        );
        routePolyline = route.encodedPolyline;
        await db.update(missions).set({ routePolyline }).where(eq(missions.id, mission.id));
      } catch (routeError) {
        console.error("Legacy mission route map could not be backfilled", routeError);
      }
    }
    mapUrl.searchParams.append("markers", `color:0x087f78|label:P|${pickup}`);
    mapUrl.searchParams.append("markers", `color:0xf05a28|label:D|${dropoff}`);
    if (routePolyline) mapUrl.searchParams.set("path", `color:0x087f78ff|weight:5|enc:${routePolyline}`);
    else if (planningView) mapUrl.searchParams.set("path", `color:0x087f78aa|weight:4|${pickup}|${dropoff}`);
  } else {
    mapUrl.searchParams.set("zoom", "14");
    mapUrl.searchParams.set("center", pickup);
    mapUrl.searchParams.set("markers", `color:0xf05a28|${pickup}`);
  }

  const response = await fetch(mapUrl, { cache: "no-store" });
  if (!response.ok) {
    console.error("Google Static Maps request failed", response.status, await response.text());
    return NextResponse.json({ error: "Mission map could not be loaded." }, { status: 502 });
  }
  return new NextResponse(await response.arrayBuffer(), {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": response.headers.get("content-type") ?? "image/png",
    },
  });
}

function coordinatePair(latitude: string, longitude: string, precision: number) {
  return `${Number(latitude).toFixed(precision)},${Number(longitude).toFixed(precision)}`;
}
