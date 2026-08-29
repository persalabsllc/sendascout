import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { missions, notifications, scoutProfiles, users } from "@/db/schema";
import { isMissionEligibleForScout } from "@/lib/scout-matching";

type MissionKind = "see" | "move" | "meet";
type NotificationInput = {
  recipientUserId: string;
  missionId?: string | null;
  kind: string;
  title: string;
  body: string;
  actionLabel?: string;
  actionUrl?: string;
  sendEmail?: boolean;
};

function missionLabel(type: MissionKind) {
  return type === "see" ? "See It" : type === "move" ? "Move It" : "Meet It";
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character] ?? character);
}

function emailHtml(title: string, body: string, actionLabel?: string, actionUrl?: string) {
  const action = actionLabel && actionUrl
    ? `<p style="margin:28px 0"><a href="${escapeHtml(actionUrl)}" style="background:#f26346;color:#fff;text-decoration:none;padding:13px 20px;border-radius:9px;font-weight:700">${escapeHtml(actionLabel)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#f4f7f6;font-family:Arial,sans-serif;color:#102d49"><div style="max-width:600px;margin:0 auto;padding:32px 18px"><div style="font-size:20px;font-weight:800;margin-bottom:24px">Send a Scout</div><div style="background:#fff;border:1px solid #dfe8e6;border-radius:16px;padding:30px"><h1 style="font-size:25px;margin:0 0 14px">${escapeHtml(title)}</h1><p style="font-size:16px;line-height:1.55;color:#526675;margin:0">${escapeHtml(body)}</p>${action}<p style="font-size:12px;color:#7a8b96;margin:28px 0 0">Mission updates are sent to the email on your Send a Scout account. You can change email alerts in your profile settings.</p></div></div></body></html>`;
}

async function sendEmail(to: string, title: string, body: string, actionLabel?: string, actionUrl?: string) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("Email delivery is not configured.");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `sendascout-${crypto.randomUUID()}`,
    },
    body: JSON.stringify({
      from: process.env.SENDASCOUT_EMAIL_FROM ?? "Send a Scout <alerts@sendascout.com>",
      to: [to],
      subject: title,
      html: emailHtml(title, body, actionLabel, actionUrl),
      text: `${title}\n\n${body}${actionUrl ? `\n\n${actionUrl}` : ""}`,
    }),
  });
  const result = await response.json() as { id?: string; message?: string };
  if (!response.ok || !result.id) throw new Error(result.message || "Email provider rejected the message.");
  return result.id;
}

export async function notifyUser(input: NotificationInput) {
  const db = getDb();
  const [recipient] = await db.select({ email: users.email, emailNotificationsEnabled: users.emailNotificationsEnabled })
    .from(users).where(eq(users.id, input.recipientUserId)).limit(1);
  if (!recipient) return;

  await db.insert(notifications).values({
    recipientUserId: input.recipientUserId,
    missionId: input.missionId ?? null,
    channel: "in_app",
    status: "sent",
    kind: input.kind,
    title: input.title,
    body: input.body,
    sentAt: new Date(),
  });

  if (input.sendEmail === false || !recipient.emailNotificationsEnabled) return;
  const [queued] = await db.insert(notifications).values({
    recipientUserId: input.recipientUserId,
    missionId: input.missionId ?? null,
    channel: "email",
    kind: input.kind,
    title: input.title,
    body: input.body,
  }).returning({ id: notifications.id });
  try {
    const providerMessageId = await sendEmail(recipient.email, input.title, input.body, input.actionLabel, input.actionUrl);
    await db.update(notifications).set({ status: "sent", providerMessageId, sentAt: new Date(), error: null }).where(eq(notifications.id, queued.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email delivery failed.";
    await db.update(notifications).set({ status: "failed", error: message }).where(eq(notifications.id, queued.id));
    console.warn("Send a Scout email delivery failed", { kind: input.kind, error: message });
  }
}

export async function alertEligibleScouts(missionId: string) {
  const db = getDb();
  const [mission] = await db.select().from(missions).where(eq(missions.id, missionId)).limit(1);
  if (!mission) return;

  const capability = mission.type === "see" ? eq(scoutProfiles.canSee, true)
    : mission.type === "move" ? eq(scoutProfiles.canMove, true) : eq(scoutProfiles.canMeet, true);
  const scoutRows = await db.select({
    userId: users.id,
    homeZip: scoutProfiles.homeZip,
    serviceRadiusMiles: scoutProfiles.serviceRadiusMiles,
    vehicleType: scoutProfiles.vehicleType,
    canSee: scoutProfiles.canSee,
    canMove: scoutProfiles.canMove,
    canMeet: scoutProfiles.canMeet,
  }).from(scoutProfiles).innerJoin(users, eq(users.id, scoutProfiles.userId))
    .where(and(eq(scoutProfiles.status, "approved"), eq(users.status, "active"), capability));
  const scouts = scoutRows.filter((scout) => isMissionEligibleForScout(mission, scout));

  const title = `New ${missionLabel(mission.type)} mission nearby`;
  const body = `${mission.city}, ${mission.state} · Scout payout $${(mission.scoutPayoutCents / 100).toFixed(0)}. Review the details and claim it if it fits your schedule.`;
  const actionUrl = `https://sendascout.com/dashboard/missions/${mission.id}`;
  await Promise.all(scouts.map((scout) => notifyUser({
    recipientUserId: scout.userId,
    missionId,
    kind: "new_mission",
    title,
    body,
    actionLabel: "Review mission",
    actionUrl,
  })));
}
