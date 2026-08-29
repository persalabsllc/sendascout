import { and, eq, lte, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { missions, missionUpdates, scoutProfiles } from "@/db/schema";
import { notifyUser } from "@/lib/notifications";

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const db = getDb();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const pending = await db.select().from(missions).where(and(eq(missions.status, "submitted"), lte(missions.submittedAt, cutoff)));
  let completed = 0;
  for (const mission of pending) {
    const now = new Date();
    const [updated] = await db.update(missions).set({ status: "completed", completedAt: now, updatedAt: now }).where(and(eq(missions.id, mission.id), eq(missions.status, "submitted"))).returning({ id: missions.id });
    if (!updated) continue;
    await db.insert(missionUpdates).values({ missionId: mission.id, status: "completed", message: "Automatically approved 24 hours after results were submitted." });
    if (mission.scoutId) {
      await db.update(scoutProfiles).set({ completedMissions: sql`${scoutProfiles.completedMissions} + 1`, updatedAt: now }).where(eq(scoutProfiles.userId, mission.scoutId));
      await notifyUser({ recipientUserId: mission.scoutId, missionId: mission.id, kind: "mission_auto_confirmed", title: "Mission automatically confirmed", body: "The 24-hour customer review window ended, so the mission is now complete.", actionLabel: "View earnings", actionUrl: "https://sendascout.com/dashboard/scout/earnings" });
    }
    await notifyUser({ recipientUserId: mission.customerId, missionId: mission.id, kind: "mission_auto_confirmed", title: "Mission automatically completed", body: "The mission was automatically completed after the 24-hour review window. Contact support promptly if there is a problem.", actionLabel: "View mission", actionUrl: `https://sendascout.com/dashboard/missions/${mission.id}` });
    completed += 1;
  }
  return NextResponse.json({ ok: true, completed });
}
