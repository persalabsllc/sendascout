import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { missionBundles, missions, notifications, scoutProfiles, users } from "@/db/schema";
import { isMissionEligibleForScout } from "@/lib/scout-matching";
import { SCOUT_HANDBOOK_VERSION } from "@/lib/scout-handbook";
import { isSentConfigured, sendSentSms } from "@/lib/sent";
import { getStripeLivemode } from "@/lib/stripe";

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

type MissionAlertRecord = typeof missions.$inferSelect;
type MissionBundleRecord = typeof missionBundles.$inferSelect;

function preferredWindowIsActive(mission: MissionAlertRecord, now = Date.now()) {
  return Boolean(
    mission.preferredScoutId
    && !mission.preferredScoutBroadcastAt
    && (!mission.preferredScoutExclusiveUntil || mission.preferredScoutExclusiveUntil.getTime() > now)
  );
}

function missionAlertCopy(mission: MissionAlertRecord, legs: MissionAlertRecord[], bundle: MissionBundleRecord | null, preferredWindowActive: boolean) {
  const labels = legs.map((leg) => missionLabel(leg.type));
  const title = preferredWindowActive
    ? `${labels.join(" + ")} offered to you first`
    : `New ${labels.join(" + ")} mission nearby`;
  const payoutCents = bundle?.scoutPayoutCents ?? mission.scoutPayoutCents;
  const preferenceCopy = preferredWindowActive ? " You have an exclusive first-look window; acceptance is still first come, first served." : "";
  return {
    title,
    body: `${mission.city}, ${mission.state} · Scout payout $${(payoutCents / 100).toFixed(0)}. Review the details and claim it if it fits your schedule.${preferenceCopy}`,
    actionLabel: "Review mission",
    actionUrl: `https://sendascout.com/dashboard/missions/${mission.id}`,
  };
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

async function sendEmail(
  to: string,
  title: string,
  body: string,
  notificationId: string,
  attempt: number,
  actionLabel?: string,
  actionUrl?: string,
) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("Email delivery is not configured.");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `sendascout-email-${notificationId}-attempt-${attempt}`,
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
    const [started] = await db.update(notifications).set({
      attemptCount: sql`${notifications.attemptCount} + 1`,
      lastAttemptAt: new Date(),
    }).where(eq(notifications.id, queued.id)).returning({ attempt: notifications.attemptCount });
    if (!started) throw new Error("Email notification attempt could not be started.");
    const providerMessageId = await sendEmail(input.email, input.title, input.body, queued.id, started.attempt, input.actionLabel, input.actionUrl);
    await db.update(notifications).set({ status: "pending", providerMessageId, sentAt: null, error: null }).where(eq(notifications.id, queued.id));
    console.info("Send a Scout email accepted by provider", {
      notificationId: queued.id,
      kind: input.kind,
      attempt: started.attempt,
      providerMessageId,
    });
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
    kind: notifications.kind,
    email: users.email,
    enabled: users.emailNotificationsEnabled,
  }).from(notifications).innerJoin(users, eq(users.id, notifications.recipientUserId))
    .where(eq(notifications.id, notificationId)).limit(1);
  if (!item || item.channel !== "email") throw new Error("Email notification not found.");
  if (!item.enabled) throw new Error("The recipient has disabled email notifications.");

  const [started] = await db.update(notifications).set({
    status: "pending",
    error: null,
    providerMessageId: null,
    sentAt: null,
    attemptCount: sql`${notifications.attemptCount} + 1`,
    lastAttemptAt: new Date(),
  }).where(eq(notifications.id, item.id)).returning({ attempt: notifications.attemptCount });
  if (!started) throw new Error("Email notification attempt could not be started.");
  try {
    const providerMessageId = await sendEmail(item.email, item.title, item.body, item.id, started.attempt, item.actionLabel ?? undefined, item.actionUrl ?? undefined);
    await db.update(notifications).set({ status: "pending", providerMessageId, sentAt: null, error: null }).where(eq(notifications.id, item.id));
    console.info("Send a Scout email accepted by provider", {
      notificationId: item.id,
      kind: item.kind,
      attempt: started.attempt,
      providerMessageId,
    });
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
  if (!mission || mission.archivedAt || mission.status !== "open" || mission.paymentStatus !== "paid" || (mission.bundleId && mission.bundleSequence !== 1)) return;

  const legs = mission.bundleId
    ? await db.select().from(missions)
      .where(and(eq(missions.bundleId, mission.bundleId), sql`${missions.archivedAt} IS NULL`))
      .orderBy(asc(missions.bundleSequence))
    : [mission];
  const [bundle] = mission.bundleId
    ? await db.select().from(missionBundles).where(eq(missionBundles.id, mission.bundleId)).limit(1)
    : [null];
  if (bundle && bundle.paymentStatus !== "paid") return;
  const stripeLivemode = getStripeLivemode();
  const scoutRows = await db.select({
    userId: users.id,
    homeZip: scoutProfiles.homeZip,
    serviceRadiusMiles: scoutProfiles.serviceRadiusMiles,
    vehicleType: scoutProfiles.vehicleType,
    canSee: scoutProfiles.canSee,
    canMove: scoutProfiles.canMove,
    canMeet: scoutProfiles.canMeet,
  }).from(scoutProfiles).innerJoin(users, eq(users.id, scoutProfiles.userId))
    .where(and(
      eq(scoutProfiles.status, "approved"),
      eq(scoutProfiles.handbookVersion, SCOUT_HANDBOOK_VERSION),
      isNotNull(scoutProfiles.handbookAcceptedAt),
      eq(scoutProfiles.stripeAccountLivemode, stripeLivemode),
      eq(scoutProfiles.stripeConnectStatus, "ready"),
      eq(scoutProfiles.stripeTransfersActive, true),
      eq(scoutProfiles.payoutsEnabled, true),
      sql`${scoutProfiles.stripePayoutScheduleConfiguredAt} IS NOT NULL`,
      sql`${scoutProfiles.stripeAccountId} IS NOT NULL`,
      eq(users.status, "active"),
    ));
  const eligibleScouts = scoutRows.filter((scout) => legs.every((leg) => isMissionEligibleForScout(leg, scout)));

  const now = Date.now();
  const preferredWindowActive = preferredWindowIsActive(mission, now);
  const scouts = preferredWindowActive
    ? eligibleScouts.filter((scout) => scout.userId === mission.preferredScoutId)
    : eligibleScouts.filter((scout) => !mission.preferredScoutBroadcastAt || scout.userId !== mission.preferredScoutId);

  const copy = missionAlertCopy(mission, legs, bundle, preferredWindowActive);
  await Promise.all(scouts.map((scout) => notifyUser({ recipientUserId: scout.userId, missionId, kind: "new_mission", ...copy })));
}

export async function alertScoutToOpenMissions(scoutUserId: string) {
  const db = getDb();
  const stripeLivemode = getStripeLivemode();
  const [scout] = await db.select({
    userId: users.id,
    homeZip: scoutProfiles.homeZip,
    serviceRadiusMiles: scoutProfiles.serviceRadiusMiles,
    vehicleType: scoutProfiles.vehicleType,
    canSee: scoutProfiles.canSee,
    canMove: scoutProfiles.canMove,
    canMeet: scoutProfiles.canMeet,
  }).from(scoutProfiles).innerJoin(users, eq(users.id, scoutProfiles.userId)).where(and(
    eq(users.id, scoutUserId),
    eq(users.status, "active"),
    eq(scoutProfiles.status, "approved"),
    eq(scoutProfiles.handbookVersion, SCOUT_HANDBOOK_VERSION),
    isNotNull(scoutProfiles.handbookAcceptedAt),
    eq(scoutProfiles.stripeAccountLivemode, stripeLivemode),
    eq(scoutProfiles.stripeConnectStatus, "ready"),
    eq(scoutProfiles.stripeTransfersActive, true),
    eq(scoutProfiles.payoutsEnabled, true),
    sql`${scoutProfiles.stripePayoutScheduleConfiguredAt} IS NOT NULL`,
    sql`${scoutProfiles.stripeAccountId} IS NOT NULL`,
  )).limit(1);
  if (!scout) return 0;

  const [openRows, existingAlerts] = await Promise.all([
    db.select().from(missions).where(and(eq(missions.status, "open"), eq(missions.paymentStatus, "paid"), sql`${missions.archivedAt} IS NULL`)).orderBy(asc(missions.createdAt)),
    db.select({ missionId: notifications.missionId }).from(notifications).where(and(
      eq(notifications.recipientUserId, scoutUserId),
      eq(notifications.channel, "in_app"),
      eq(notifications.kind, "new_mission"),
    )),
  ]);
  const roots = openRows.filter((mission) => !mission.bundleId || mission.bundleSequence === 1);
  const bundleIds = [...new Set(roots.flatMap((mission) => mission.bundleId ? [mission.bundleId] : []))];
  const [bundleRows, bundleLegs] = bundleIds.length ? await Promise.all([
    db.select().from(missionBundles).where(inArray(missionBundles.id, bundleIds)),
    db.select().from(missions).where(and(inArray(missions.bundleId, bundleIds), sql`${missions.archivedAt} IS NULL`)).orderBy(asc(missions.bundleSequence)),
  ]) : [[], []];
  const bundleById = new Map(bundleRows.map((bundle) => [bundle.id, bundle]));
  const legsByBundle = new Map<string, MissionAlertRecord[]>();
  for (const leg of bundleLegs) {
    if (!leg.bundleId) continue;
    const legs = legsByBundle.get(leg.bundleId) ?? [];
    legs.push(leg);
    legsByBundle.set(leg.bundleId, legs);
  }
  const alreadyAlerted = new Set(existingAlerts.flatMap((item) => item.missionId ? [item.missionId] : []));
  const candidates = roots.filter((mission) => {
    if (alreadyAlerted.has(mission.id)) return false;
    const preferredWindowActive = preferredWindowIsActive(mission);
    if (preferredWindowActive && mission.preferredScoutId !== scoutUserId) return false;
    if (mission.bundleId && bundleById.get(mission.bundleId)?.paymentStatus !== "paid") return false;
    const legs = mission.bundleId ? legsByBundle.get(mission.bundleId) ?? [mission] : [mission];
    return legs.every((leg) => isMissionEligibleForScout(leg, scout));
  });

  await Promise.all(candidates.map((mission) => {
    const legs = mission.bundleId ? legsByBundle.get(mission.bundleId) ?? [mission] : [mission];
    const bundle = mission.bundleId ? bundleById.get(mission.bundleId) ?? null : null;
    const copy = missionAlertCopy(mission, legs, bundle, preferredWindowIsActive(mission));
    return notifyUser({ recipientUserId: scoutUserId, missionId: mission.id, kind: "new_mission", ...copy });
  }));
  return candidates.length;
}
