import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { missionBundles, missions } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";

export async function POST(request: Request) {
  try {
    const body = await request.json() as HandleUploadBody;
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const user = await requireAppUser("scout");
        const payload = JSON.parse(clientPayload || "{}") as { missionId?: string };
        if (!payload.missionId) throw new Error("Mission information is missing.");
        const [mission] = await getDb().select().from(missions).where(eq(missions.id, payload.missionId)).limit(1);
        if (!mission || mission.scoutId !== user.id) throw new Error("You cannot upload results for this mission.");
        if (mission.bundleId) {
          const [activeBundle] = await getDb().select({ id: missionBundles.id }).from(missionBundles).where(and(
            eq(missionBundles.id, mission.bundleId),
            eq(missionBundles.activeSequence, mission.bundleSequence ?? 0),
          )).limit(1);
          if (!activeBundle) throw new Error("Complete the active mission part before uploading results here.");
        }
        const ready = mission.type === "move" ? mission.status === "at_dropoff" : mission.status === "onsite";
        if (!ready || !pathname.startsWith(`mission-results/${mission.id}/`)) throw new Error("This mission is not ready for result uploads.");
        const [authorized] = await getDb().update(missions).set({
          resultUploadTokenCount: sql`${missions.resultUploadTokenCount} + 1`,
          updatedAt: new Date(),
        }).where(and(
          eq(missions.id, mission.id),
          eq(missions.scoutId, user.id),
          eq(missions.status, mission.status),
          isNull(missions.archivedAt),
          lt(missions.resultUploadTokenCount, 30),
        )).returning({ id: missions.id });
        if (!authorized) throw new Error("Mission result uploads are limited to 30 files. Contact support if you need help completing this mission.");
        return {
          allowedContentTypes: ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime", "video/webm"],
          maximumSizeInBytes: 50 * 1024 * 1024,
          validUntil: Date.now() + 15 * 60 * 1000,
          addRandomSuffix: false,
          allowOverwrite: false,
          tokenPayload: JSON.stringify({ missionId: mission.id, scoutId: user.id }),
        };
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Upload could not be authorized." }, { status: 400 });
  }
}
