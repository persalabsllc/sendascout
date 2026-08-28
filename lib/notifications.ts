import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { missions, notifications, scoutProfiles, users } from "@/db/schema";
import { isMissionEligibleForScout } from "@/lib/scout-matching";

type MissionKind = "see" | "move" | "meet";

function missionLabel(type: MissionKind) {
  return type === "see" ? "See It" : type === "move" ? "Move It" : "Meet It";
}

function smsConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM_NUMBER,
  );
}

async function sendSms(to: string, body: string) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID!;
  const token = process.env.TWILIO_AUTH_TOKEN!;
  const from = process.env.TWILIO_FROM_NUMBER!;
  const digits = to.replace(/\D/g, "");
  const recipient = digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith("1") ? `+${digits}` : to;
  const payload = new URLSearchParams({ To: recipient, From: from, Body: body });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: payload,
  });
  const result = await response.json() as { sid?: string; message?: string };
  if (!response.ok || !result.sid) throw new Error(result.message || "Twilio rejected the message.");
  return result.sid;
}

export async function alertEligibleScouts(missionId: string) {
  const db = getDb();
  const [mission] = await db.select().from(missions).where(eq(missions.id, missionId)).limit(1);
  if (!mission) return;

  const capability = mission.type === "see"
    ? eq(scoutProfiles.canSee, true)
    : mission.type === "move"
      ? eq(scoutProfiles.canMove, true)
      : eq(scoutProfiles.canMeet, true);
  const scoutRows = await db
    .select({
      userId: users.id,
      phone: users.phone,
      homeZip: scoutProfiles.homeZip,
      serviceRadiusMiles: scoutProfiles.serviceRadiusMiles,
      vehicleType: scoutProfiles.vehicleType,
      canSee: scoutProfiles.canSee,
      canMove: scoutProfiles.canMove,
      canMeet: scoutProfiles.canMeet,
    })
    .from(scoutProfiles)
    .innerJoin(users, eq(users.id, scoutProfiles.userId))
    .where(and(eq(scoutProfiles.status, "approved"), eq(users.status, "active"), capability));
  const scouts = scoutRows.filter((scout) => isMissionEligibleForScout(mission, scout));

  const title = `New ${missionLabel(mission.type)} mission`;
  const body = `${mission.city}, ${mission.state} · Scout payout $${(mission.scoutPayoutCents / 100).toFixed(0)}. Review: https://sendascout.com/dashboard/missions/${mission.id}`;

  for (const scout of scouts) {
    await db.insert(notifications).values({
      recipientUserId: scout.userId,
      missionId,
      channel: "in_app",
      status: "sent",
      kind: "new_mission",
      title,
      body,
      sentAt: new Date(),
    });

    if (!smsConfigured() || !scout.phone) continue;
    const [queued] = await db.insert(notifications).values({
      recipientUserId: scout.userId,
      missionId,
      channel: "sms",
      kind: "new_mission",
      title,
      body,
    }).returning({ id: notifications.id });
    try {
      const providerMessageId = await sendSms(scout.phone, `${title}: ${body}`);
      await db.update(notifications).set({ status: "sent", providerMessageId, sentAt: new Date() }).where(eq(notifications.id, queued.id));
    } catch (error) {
      await db.update(notifications).set({ status: "failed", error: error instanceof Error ? error.message : "SMS failed" }).where(eq(notifications.id, queued.id));
    }
  }
}
