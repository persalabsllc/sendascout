import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { missions, scoutProfiles } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";
import { computeDrivingRoute } from "@/lib/google-maps";
import { isMissionEligibleForScout } from "@/lib/scout-matching";

export async function GET(request: Request) {
  const user = await requireAppUser("customer");
  const missionId = new URL(request.url).searchParams.get("missionId");
  if (!missionId) return NextResponse.json({ error: "Mission ID is required." }, { status: 400 });

  const db = getDb();
  const [mission] = await db.select().from(missions).where(eq(missions.id, missionId)).limit(1);
  if (!mission) return NextResponse.json({ error: "Mission not found." }, { status: 404 });

  let allowed = mission.customerId === user.id || mission.scoutId === user.id || user.role === "admin";
  if (!allowed && user.role === "scout" && mission.status === "open" && !mission.scoutId) {
    const [profile] = await db.select().from(scoutProfiles).where(eq(scoutProfiles.userId, user.id)).limit(1);
    allowed = Boolean(profile && profile.status === "approved" && isMissionEligibleForScout(mission, profile));
  }
  if (!allowed) return NextResponse.json({ error: "You cannot view this mission map." }, { status: 403 });

  const key = process.env.GOOGLE_MAPS_SERVER_API_KEY;
  if (!key || !mission.pickupLatitude || !mission.pickupLongitude) return NextResponse.json({ error: "Mission map is unavailable." }, { status: 503 });

  const planningView = user.role === "scout" && mission.scoutId !== user.id;
  const pickup = coordinatePair(mission.pickupLatitude, mission.pickupLongitude, planningView);
  const mapUrl = new URL("https://maps.googleapis.com/maps/api/staticmap");
  mapUrl.searchParams.set("size", "900x480");
  mapUrl.searchParams.set("scale", "2");
  mapUrl.searchParams.set("maptype", "roadmap");
  mapUrl.searchParams.set("key", key);

  if (mission.type === "move" && mission.dropoffLatitude && mission.dropoffLongitude) {
    const dropoff = coordinatePair(mission.dropoffLatitude, mission.dropoffLongitude, planningView);
    let routePolyline = mission.routePolyline;
    if (!routePolyline) {
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

function coordinatePair(latitude: string, longitude: string, approximate: boolean) {
  const precision = approximate ? 3 : 6;
  return `${Number(latitude).toFixed(precision)},${Number(longitude).toFixed(precision)}`;
}
