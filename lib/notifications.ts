import { and, asc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { missionBundles, missions, notifications, scoutProfiles, users } from "@/db/schema";
import { isMissionEligibleForScout } from "@/lib/scout-matching";
import { isSentConfigured, sendSentSms } from "@/lib/sent";

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
  sendSms?: boolean;
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
  const [recipient] = await db.select({
    email: users.email,
    phone: users.phone,
    emailNotificationsEnabled: users.emailNotificationsEnabled,
    smsNotificationsEnabled: users.smsNotificationsEnabled,
    smsConsentedAt: users.smsConsentedAt,
  })
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
    actionLabel: input.actionLabel ?? null,
    actionUrl: input.actionUrl ?? null,
    sentAt: new Date(),
  });

  const deliveries: Promise<void>[] = [];
  if (input.sendEmail !== false && recipient.emailNotificationsEnabled) deliveries.push(queueEmail({ ...input, email: recipient.email }));
  if (input.sendSms !== false && recipient.smsNotificationsEnabled && recipient.smsConsentedAt && recipient.phone && isSentConfigured()) deliveries.push(queueSms({ ...input, phone: recipient.phone }));
  await Promise.all(deliveries);
}

async function queueEmail(input: NotificationInput & { email: string }) {
  const db = getDb();
  const [queued] = await db.insert(notifications).values({
    recipientUserId: input.recipientUserId,
    missionId: input.missionId ?? null,
    channel: "email",
    kind: input.kind,
    title: input.title,
    body: input.body,
    actionLabel: input.actionLabel ?? null,
    actionUrl: input.actionUrl ?? null,
  }).returning({ id: notifications.id });
  try {
    await db.update(notifications).set({ attemptCount: sql`${notifications.attemptCount} + 1`, lastAttemptAt: new Date() }).where(eq(notifications.id, queued.id));
    const providerMessageId = await sendEmail(input.email, input.title, input.body, input.actionLabel, input.actionUrl);
    await db.update(notifications).set({ status: "sent", providerMessageId, sentAt: new Date(), error: null }).where(eq(notifications.id, queued.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email delivery failed.";
    await db.update(notifications).set({ status: "failed", error: message }).where(eq(notifications.id, queued.id));
    console.warn("Send a Scout email delivery failed", { kind: input.kind, error: message });
  }
}

async function queueSms(input: NotificationInput & { phone: string }) {
  const db = getDb();
  const [queued] = await db.insert(notifications).values({
    recipientUserId: input.recipientUserId,
    missionId: input.missionId ?? null,
    channel: "sms",
    kind: input.kind,
    title: input.title,
    body: input.body,
    actionLabel: input.actionLabel ?? null,
    actionUrl: input.actionUrl ?? null,
  }).returning({ id: notifications.id });
  try {
    await db.update(notifications).set({ attemptCount: sql`${notifications.attemptCount} + 1`, lastAttemptAt: new Date() }).where(eq(notifications.id, queued.id));
    const providerMessageId = await sendSentSms({ notificationId: queued.id, to: input.phone, title: input.title, body: input.body, actionUrl: input.actionUrl });
    await db.update(notifications).set({ status: "pending", providerMessageId, error: null }).where(eq(notifications.id, queued.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : "SMS delivery failed.";
    await db.update(notifications).set({ status: "failed", error: message }).where(eq(notifications.id, queued.id));
    console.warn("Send a Scout SMS delivery failed", { kind: input.kind, error: message });
  }
}

export async function retryEmailNotification(notificationId: string) {
  const db = getDb();
  const [item] = await db.select({
    id: notifications.id,
    channel: notifications.channel,
    status: notifications.status,
    title: notifications.title,
    body: notifications.body,
    actionLabel: notifications.actionLabel,
    actionUrl: notifications.actionUrl,
    email: users.email,
    enabled: users.emailNotificationsEnabled,
  }).from(notifications).innerJoin(users, eq(users.id, notifications.recipientUserId))
    .where(eq(notifications.id, notificationId)).limit(1);
  if (!item || item.channel !== "email") throw new Error("Email notification not found.");
  if (item.status === "sent") throw new Error("This email was already delivered.");
  if (!item.enabled) throw new Error("The recipient has disabled email notifications.");

  await db.update(notifications).set({
    status: "pending",
    error: null,
    attemptCount: sql`${notifications.attemptCount} + 1`,
    lastAttemptAt: new Date(),
  }).where(eq(notifications.id, item.id));
  try {
    const providerMessageId = await sendEmail(item.email, item.title, item.body, item.actionLabel ?? undefined, item.actionUrl ?? undefined);
    await db.update(notifications).set({ status: "sent", providerMessageId, sentAt: new Date(), error: null }).where(eq(notifications.id, item.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email delivery failed.";
    await db.update(notifications).set({ status: "failed", error: message }).where(eq(notifications.id, item.id));
    throw new Error(message);
  }
}

export async function retrySmsNotification(notificationId: string) {
  const db = getDb();
  const [item] = await db.select({
    id: notifications.id,
    channel: notifications.channel,
    status: notifications.status,
    title: notifications.title,
    body: notifications.body,
    actionUrl: notifications.actionUrl,
    phone: users.phone,
    enabled: users.smsNotificationsEnabled,
    consentedAt: users.smsConsentedAt,
  }).from(notifications).innerJoin(users, eq(users.id, notifications.recipientUserId))
    .where(eq(notifications.id, notificationId)).limit(1);
  if (!item || item.channel !== "sms") throw new Error("SMS notification not found.");
  if (item.status === "sent") throw new Error("This text was already delivered.");
  if (!item.enabled || !item.consentedAt) throw new Error("The recipient has not enabled text notifications.");
  if (!item.phone) throw new Error("The recipient does not have a mobile number.");
  if (!isSentConfigured()) throw new Error("Sent SMS delivery is not configured.");

  await db.update(notifications).set({ status: "pending", error: null, attemptCount: sql`${notifications.attemptCount} + 1`, lastAttemptAt: new Date() }).where(eq(notifications.id, item.id));
  try {
    const providerMessageId = await sendSentSms({ notificationId: item.id, to: item.phone, title: item.title, body: item.body, actionUrl: item.actionUrl });
    await db.update(notifications).set({ status: "pending", providerMessageId, error: null }).where(eq(notifications.id, item.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : "SMS delivery failed.";
    await db.update(notifications).set({ status: "failed", error: message }).where(eq(notifications.id, item.id));
    throw new Error(message);
  }
}

export async function retryNotification(notificationId: string) {
  const [item] = await getDb().select({ channel: notifications.channel }).from(notifications).where(eq(notifications.id, notificationId)).limit(1);
  if (!item) throw new Error("Notification not found.");
  if (item.channel === "email") return retryEmailNotification(notificationId);
  if (item.channel === "sms") return retrySmsNotification(notificationId);
  throw new Error("In-app notifications cannot be retried.");
}

export async function alertEligibleScouts(missionId: string) {
  const db = getDb();
  const [mission] = await db.select().from(missions).where(eq(missions.id, missionId)).limit(1);
  // Secondary bundle legs remain private until the preceding leg is complete.
  if (!mission || mission.archivedAt || mission.status !== "open" || (mission.bundleId && mission.bundleSequence !== 1)) return;

  const legs = mission.bundleId
    ? await db.select().from(missions)
      .where(and(eq(missions.bundleId, mission.bundleId), sql`${missions.archivedAt} IS NULL`))
      .orderBy(asc(missions.bundleSequence))
    : [mission];
  const [bundle] = mission.bundleId
    ? await db.select().from(missionBundles).where(eq(missionBundles.id, mission.bundleId)).limit(1)
    : [null];
  const scoutRows = await db.select({
    userId: users.id,
    homeZip: scoutProfiles.homeZip,
    serviceRadiusMiles: scoutProfiles.serviceRadiusMiles,
    vehicleType: scoutProfiles.vehicleType,
    canSee: scoutProfiles.canSee,
    canMove: scoutProfiles.canMove,
    canMeet: scoutProfiles.canMeet,
  }).from(scoutProfiles).innerJoin(users, eq(users.id, scoutProfiles.userId))
    .where(and(eq(scoutProfiles.status, "approved"), eq(users.status, "active")));
  const eligibleScouts = scoutRows.filter((scout) => legs.every((leg) => isMissionEligibleForScout(leg, scout)));

  const now = Date.now();
  const preferredWindowActive = Boolean(
    mission.preferredScoutId
    && mission.preferredScoutExclusiveUntil
    && mission.preferredScoutExclusiveUntil.getTime() > now
    && !mission.preferredScoutBroadcastAt,
  );
  const scouts = preferredWindowActive
    ? eligibleScouts.filter((scout) => scout.userId === mission.preferredScoutId)
    : eligibleScouts.filter((scout) => !mission.preferredScoutBroadcastAt || scout.userId !== mission.preferredScoutId);

  const labels = legs.map((leg) => missionLabel(leg.type));
  const title = preferredWindowActive
    ? `${labels.join(" + ")} offered to you first`
    : `New ${labels.join(" + ")} mission nearby`;
  const payoutCents = bundle?.scoutPayoutCents ?? mission.scoutPayoutCents;
  const preferenceCopy = preferredWindowActive ? " You have an exclusive first-look window; acceptance is still first come, first served." : "";
  const body = `${mission.city}, ${mission.state} · Scout payout $${(payoutCents / 100).toFixed(0)}. Review the details and claim it if it fits your schedule.${preferenceCopy}`;
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
