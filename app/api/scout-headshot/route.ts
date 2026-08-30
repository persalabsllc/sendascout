import { get } from "@vercel/blob";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db";
import { missions, scoutProfiles } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";

export async function GET(request: NextRequest) {
  try {
    const requestedMissionId = request.nextUrl.searchParams.get("missionId");
    const requestedScoutId = request.nextUrl.searchParams.get("scoutId");
    const user = await requireAppUser("customer");
    const db = getDb();
    if (requestedMissionId) {
      const [mission] = await db.select({
        customerId: missions.customerId,
        scoutId: missions.scoutId,
        snapshotPath: missions.scoutHeadshotPathSnapshot,
        profilePath: scoutProfiles.headshotPath,
      }).from(missions).leftJoin(scoutProfiles, eq(scoutProfiles.userId, missions.scoutId)).where(eq(missions.id, requestedMissionId)).limit(1);
      if (!mission || (user.role !== "admin" && mission.customerId !== user.id && mission.scoutId !== user.id)) {
        return new NextResponse("Not found", { status: 404 });
      }
      const pathname = mission.snapshotPath ?? mission.profilePath;
      if (!pathname) return new NextResponse("Not found", { status: 404 });
      return privateBlobResponse(pathname, request);
    }
    const scoutId = requestedScoutId === "self" ? user.id : requestedScoutId;
    if (!scoutId) return new NextResponse("Not found", { status: 404 });
    const [[profile], sharedMissions] = await Promise.all([
      db.select({ headshotPath: scoutProfiles.headshotPath }).from(scoutProfiles).where(eq(scoutProfiles.userId, scoutId)).limit(1),
      scoutId === user.id || user.role === "admin" ? Promise.resolve([{ id: "self" }]) : db.select({ id: missions.id }).from(missions).where(and(eq(missions.customerId, user.id), eq(missions.scoutId, scoutId))).limit(1),
    ]);
    if (!profile?.headshotPath || sharedMissions.length === 0) return new NextResponse("Not found", { status: 404 });
    return privateBlobResponse(profile.headshotPath, request);
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}

async function privateBlobResponse(pathname: string, request: NextRequest) {
  const result = await get(pathname, { access: "private", ifNoneMatch: request.headers.get("if-none-match") ?? undefined });
  if (!result) return new NextResponse("Not found", { status: 404 });
  if (result.statusCode === 304) return new NextResponse(null, { status: 304, headers: { ETag: result.blob.etag, "Cache-Control": "private, max-age=300" } });
  if (result.statusCode !== 200) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(result.stream, { headers: { "Content-Type": result.blob.contentType, "Content-Disposition": "inline", "X-Content-Type-Options": "nosniff", ETag: result.blob.etag, "Cache-Control": "private, max-age=300" } });
}
