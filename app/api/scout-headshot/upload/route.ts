import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { and, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { missions, scoutProfiles } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";
import { SCOUT_HEADSHOT_ALLOWED_CONTENT_TYPES, SCOUT_HEADSHOT_MAX_BYTES } from "@/lib/scout-headshot-policy";

export async function POST(request: Request) {
  try {
    const body = await request.json() as HandleUploadBody;
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        const user = await requireAppUser("scout");
        if (user.role !== "scout" || user.status !== "active") throw new Error("Only active Scouts can upload a profile photo.");
        if (!pathname.startsWith(`scout-headshots/${user.id}/`) || pathname.includes("..")) throw new Error("Invalid profile photo path.");
        const [activeMission] = await getDb().select({ id: missions.id }).from(missions).where(and(
          eq(missions.scoutId, user.id),
          inArray(missions.status, ["claimed", "en_route", "onsite", "en_route_pickup", "at_pickup", "en_route_dropoff", "at_dropoff", "submitted", "disputed"]),
          isNull(missions.archivedAt),
        )).limit(1);
        if (activeMission) throw new Error("Finish or resolve your active mission before changing the profile photo customers rely on.");
        const now = new Date();
        const windowCutoff = new Date(now.getTime() - 60 * 60 * 1000);
        const [authorized] = await getDb().update(scoutProfiles).set({
          headshotUploadWindowStartedAt: sql`CASE
            WHEN ${scoutProfiles.headshotUploadWindowStartedAt} IS NULL OR ${scoutProfiles.headshotUploadWindowStartedAt} < ${windowCutoff}
            THEN ${now}
            ELSE ${scoutProfiles.headshotUploadWindowStartedAt}
          END`,
          headshotUploadCount: sql`CASE
            WHEN ${scoutProfiles.headshotUploadWindowStartedAt} IS NULL OR ${scoutProfiles.headshotUploadWindowStartedAt} < ${windowCutoff}
            THEN 1
            ELSE ${scoutProfiles.headshotUploadCount} + 1
          END`,
          updatedAt: now,
        }).where(and(
          eq(scoutProfiles.userId, user.id),
          ne(scoutProfiles.status, "rejected"),
          or(
            isNull(scoutProfiles.headshotUploadWindowStartedAt),
            lt(scoutProfiles.headshotUploadWindowStartedAt, windowCutoff),
            lt(scoutProfiles.headshotUploadCount, 3),
          ),
        )).returning({ id: scoutProfiles.id });
        if (!authorized) throw new Error("Profile photo uploads are limited to three per hour. Try again later or contact support.");
        return {
          allowedContentTypes: [...SCOUT_HEADSHOT_ALLOWED_CONTENT_TYPES],
          maximumSizeInBytes: SCOUT_HEADSHOT_MAX_BYTES,
          validUntil: Date.now() + 10 * 60 * 1000,
          addRandomSuffix: false,
          allowOverwrite: false,
          tokenPayload: JSON.stringify({ scoutId: user.id }),
        };
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Upload could not be authorized." }, { status: 400 });
  }
}
