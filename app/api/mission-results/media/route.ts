import { get } from "@vercel/blob";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db";
import { missionUpdates, missions } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";

export async function GET(request: NextRequest) {
  try {
    const missionId = request.nextUrl.searchParams.get("missionId");
    const pathname = request.nextUrl.searchParams.get("pathname");
    if (!missionId || !pathname || !pathname.startsWith(`mission-results/${missionId}/`) || pathname.includes("..")) {
      return NextResponse.json({ error: "Invalid mission evidence request." }, { status: 400 });
    }

    const user = await requireAppUser("customer");
    const db = getDb();
    const [[mission], [evidence]] = await Promise.all([
      db.select({ customerId: missions.customerId, scoutId: missions.scoutId })
        .from(missions)
        .where(eq(missions.id, missionId))
        .limit(1),
      db.select({ id: missionUpdates.id })
        .from(missionUpdates)
        .where(and(eq(missionUpdates.missionId, missionId), eq(missionUpdates.mediaUrl, pathname)))
        .limit(1),
    ]);

    const participant = mission && (mission.customerId === user.id || mission.scoutId === user.id || user.role === "admin");
    if (!participant || !evidence) return new NextResponse("Not found", { status: 404 });

    const result = await get(pathname, {
      access: "private",
      ifNoneMatch: request.headers.get("if-none-match") ?? undefined,
    });
    if (!result) return new NextResponse("Not found", { status: 404 });
    if (result.statusCode === 304) {
      return new NextResponse(null, {
        status: 304,
        headers: { ETag: result.blob.etag, "Cache-Control": "private, no-cache" },
      });
    }
    if (result.statusCode !== 200) return new NextResponse("Not found", { status: 404 });

    return new NextResponse(result.stream, {
      headers: {
        "Content-Type": result.blob.contentType,
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        ETag: result.blob.etag,
        "Cache-Control": "private, no-cache",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
