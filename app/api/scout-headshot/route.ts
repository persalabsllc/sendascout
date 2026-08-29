import { get } from "@vercel/blob";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db";
import { missions, scoutProfiles } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";

export async function GET(request: NextRequest) {
  try {
    const requestedScoutId = request.nextUrl.searchParams.get("scoutId");
    const user = await requireAppUser("customer");
    const scoutId = requestedScoutId === "self" ? user.id : requestedScoutId;
    if (!scoutId) return new NextResponse("Not found", { status: 404 });
    const db = getDb();
    const [[profile], sharedMissions] = await Promise.all([
      db.select({ headshotPath: scoutProfiles.headshotPath }).from(scoutProfiles).where(eq(scoutProfiles.userId, scoutId)).limit(1),
      scoutId === user.id || user.role === "admin" ? Promise.resolve([{ id: "self" }]) : db.select({ id: missions.id }).from(missions).where(and(eq(missions.customerId, user.id), eq(missions.scoutId, scoutId))).limit(1),
    ]);
    if (!profile?.headshotPath || sharedMissions.length === 0) return new NextResponse("Not found", { status: 404 });
    const result = await get(profile.headshotPath, { access: "private", ifNoneMatch: request.headers.get("if-none-match") ?? undefined });
    if (!result) return new NextResponse("Not found", { status: 404 });
    if (result.statusCode === 304) return new NextResponse(null, { status: 304, headers: { ETag: result.blob.etag, "Cache-Control": "private, max-age=300" } });
    if (result.statusCode !== 200) return new NextResponse("Not found", { status: 404 });
    return new NextResponse(result.stream, { headers: { "Content-Type": result.blob.contentType, "Content-Disposition": "inline", "X-Content-Type-Options": "nosniff", ETag: result.blob.etag, "Cache-Control": "private, max-age=300" } });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
