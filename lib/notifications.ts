import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { missionBundles, missions, notifications, scoutProfiles, users } from "@/db/schema";
import { getAppUrl } from "@/lib/app-url";
import { scoutClaimReadinessConditions } from "@/lib/scout-claim-readiness";
import { isMissionEligibleForScout } from "@/lib/scout-matching";
import { isScoutOnboardingNotificationKind, scoutOnboardingReminderBody } from "@/lib/scout-onboarding-reminder-policy";
import { loadActiveScoutOnboarding, onboardingProgressFor } from "@/lib/scout-onboarding-status";
import { applyStoredSentMessageEvent } from "@/lib/sent-delivery-events";
import { isSentConfigured, isSentSmsErrorRetryable, sendSentSms } from "@/lib/sent";
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
  /** Distinguishes separate durable publications that reuse the same kind. */
  dedupeScope?: string;
};

class EmailProviderRejectedError extends Error {}

// Resend and Sent both retain idempotency keys for 24 hours. Stop automatic
// recovery one hour early so an outcome-unknown request can never be replayed
// after the provider may have forgotten its key.
const PROVIDER_IDEMPOTENCY_REPLAY_WINDOW_MS = 23 * 60 * 60 * 1000;
const OUTCOME_UNKNOWN_RECONCILIATION_ERROR = "Provider outcome is unknown and the safe automatic retry window expired. Reconcile the provider dashboard before sending again.";

function notificationEventKey(input: Pick<NotificationInput, "recipientUserId" | "missionId" | "kind" | "dedupeScope">) {
  return createHash("sha256")
    .update(JSON.stringify([input.recipientUserId, input.missionId ?? null, input.kind, input.dedupeScope ?? null]))
    .digest("hex");
}

export function notificationChannelDedupeKey(
  input: Pick<NotificationInput, "recipientUserId" | "missionId" | "kind" | "dedupeScope">,
  channel: "in_app" | "email" | "sms",
) {
  return `${notificationEventKey(input)}:${channel}`;
}

export function missionClaimedNotificationInput(input: {
  customerUserId: string;
  missionId: string;
  bundleLegCount?: number;
}): NotificationInput {
  const bundleLegCount = Math.max(1, Math.trunc(input.bundleLegCount ?? 1));
  return {
    recipientUserId: input.customerUserId,
    missionId: input.missionId,
    kind: "mission_claimed",
    dedupeScope: "authoritative_claim",
    title: "Your mission has a Scout",
    body: bundleLegCount > 1
      ? `A Scout accepted all ${bundleLegCount} parts of your mission. Open it to follow progress and send a private message.`
      : "A Scout accepted your mission. Open it to follow progress and send a private message.",
    actionLabel: "Track mission",
    actionUrl: `https://sendascout.com/dashboard/missions/${input.missionId}`,
  };
}

function missionLabel(type: MissionKind) {
  return type === "see" ? "See It" : type === "move" ? "Move It" : "Meet It";
}

type MissionAlertRecord = typeof missions.$inferSelect;
type MissionBundleRecord = typeof missionBundles.$inferSelect;

function preferredAlertIsExclusive(mission: MissionAlertRecord) {
  // The durable broadcast marker, rather than wall-clock time, decides who
  // receives alerts. This closes the gap between an exclusive window expiring
  // and the release worker publishing the mission to every eligible Scout.
  return Boolean(mission.preferredScoutId && !mission.preferredScoutBroadcastAt);
}

function missionAlertCopy(mission: MissionAlertRecord, legs: MissionAlertRecord[], bundle: MissionBundleRecord | null, preferredOnly: boolean) {
  const labels = legs.map((leg) => missionLabel(leg.type));
  const title = preferredOnly
    ? `${labels.join(" + ")} offered to you first`
    : `New ${labels.join(" + ")} mission nearby`;
  const payoutCents = bundle?.scoutPayoutCents ?? mission.scoutPayoutCents;
  const preferenceCopy = preferredOnly ? " You were selected for first look; claim it if it is still available." : "";
  return {
    title,
    body: `${mission.city}, ${mission.state} · Scout payout $${(payoutCents / 100).toFixed(0)}. Review the details and claim it if it fits your schedule.${preferenceCopy}`,
    actionLabel: "Review mission",
    actionUrl: `https://sendascout.com/dashboard/missions/${mission.id}`,
  };
}

function missionAlertScopeForGeneration(missionId: string, generation: number) {
  return `mission:${missionId}:generation:${generation}`;
}

function missionAlertScope(mission: Pick<MissionAlertRecord, "id" | "alertGeneration">) {
  return missionAlertScopeForGeneration(mission.id, mission.alertGeneration);
}

function missionAlertTarget(mission: MissionAlertRecord, scoutUserId: string) {
  const recoveringReleasedPreference = Boolean(
    mission.preferredScoutId === scoutUserId
    && mission.preferredScoutBroadcastAt
    && mission.preferredScoutBroadcastGeneration === mission.alertGeneration
    && mission.alertGeneration > 0
  );
  return {
    scope: recoveringReleasedPreference
      ? missionAlertScopeForGeneration(mission.id, mission.alertGeneration - 1)
      : missionAlertScope(mission),
    preferredCopy: preferredAlertIsExclusive(mission) || recoveringReleasedPreference,
    generation: recoveringReleasedPreference ? mission.alertGeneration - 1 : mission.alertGeneration,
  };
}

async function adoptLegacyMissionAlertKeys(
  scoutUserId: string,
  missionId: string,
  scope: string,
  generation: number,
) {
  if (generation !== 0) return;
  const db = getDb();
  const leaseCutoff = new Date(Date.now() - 5 * 60 * 1000);
  const eventKey = notificationEventKey({
    recipientUserId: scoutUserId,
    missionId,
    kind: "new_mission",
    dedupeScope: scope,
  });
  for (const channel of ["in_app", "email", "sms"] as const) {
    const targetKey = `${eventKey}:${channel}`;
    await db.execute(sql`
      WITH candidate AS (
        SELECT legacy.id
        FROM notifications AS legacy
        WHERE legacy.recipient_user_id = ${scoutUserId}
          AND legacy.mission_id = ${missionId}
          AND legacy.kind = 'new_mission'
          AND legacy.channel = ${channel}::notification_channel
          AND legacy.dedupe_key IS NULL
        ORDER BY legacy.created_at, legacy.id
        LIMIT 1
      )
      UPDATE notifications AS legacy
      SET dedupe_key = ${targetKey}
      FROM candidate
      WHERE legacy.id = candidate.id
        AND NOT EXISTS (
          SELECT 1 FROM notifications AS existing
          WHERE existing.dedupe_key = ${targetKey}
      )
    `);
    if (channel !== "in_app") {
      await db.update(notifications).set({
        status: "failed",
        error: "Superseded by the canonical legacy mission alert delivery.",
      }).where(and(
        eq(notifications.recipientUserId, scoutUserId),
        eq(notifications.missionId, missionId),
        eq(notifications.kind, "new_mission"),
        eq(notifications.channel, channel),
        isNull(notifications.dedupeKey),
        eq(notifications.status, "pending"),
        isNull(notifications.providerMessageId),
        sql`(
          ${notifications.attemptCount} = 0
          OR ${notifications.lastAttemptAt} IS NULL
          OR ${notifications.lastAttemptAt} <= ${leaseCutoff}
        )`,
      ));
    }
  }
}

async function scoutStillEligibleForMissionAlert(scoutUserId: string, missionId: string, expectedScope: string) {
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
    ...scoutClaimReadinessConditions(stripeLivemode),
  )).limit(1);
  if (!scout) return false;

  const [mission] = await db.select().from(missions).where(and(
    eq(missions.id, missionId),
    eq(missions.status, "open"),
    eq(missions.paymentStatus, "paid"),
    isNull(missions.archivedAt),
  )).limit(1);
  if (!mission || (mission.bundleId && mission.bundleSequence !== 1)) return false;
  const preferredOnly = preferredAlertIsExclusive(mission);
  if (preferredOnly && mission.preferredScoutId !== scoutUserId) return false;
  if (missionAlertTarget(mission, scoutUserId).scope !== expectedScope) return false;

  const legs = mission.bundleId
    ? await db.select().from(missions).where(and(
      eq(missions.bundleId, mission.bundleId),
      isNull(missions.archivedAt),
    )).orderBy(asc(missions.bundleSequence))
    : [mission];
  if (!legs.every((leg) => leg.paymentStatus === "paid" && isMissionEligibleForScout(leg, scout))) return false;
  if (mission.bundleId) {
    const [bundle] = await db.select({ paymentStatus: missionBundles.paymentStatus })
      .from(missionBundles).where(eq(missionBundles.id, mission.bundleId)).limit(1);
    if (bundle?.paymentStatus !== "paid") return false;
  }
  return true;
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
  return `<!doctype html><html><body style="margin:0;background:#f4f7f6;font-family:Arial,sans-serif;color:#102d49"><div style="max-width:600px;margin:0 auto;padding:32px 18px"><div style="font-size:20px;font-weight:800;margin-bottom:24px">Send a Scout</div><div style="background:#fff;border:1px solid #dfe8e6;border-radius:16px;padding:30px"><h1 style="font-size:25px;margin:0 0 14px">${escapeHtml(title)}</h1><p style="font-size:16px;line-height:1.55;color:#526675;margin:0;white-space:pre-line">${escapeHtml(body)}</p>${action}<p style="font-size:12px;line-height:1.55;color:#7a8b96;margin:28px 0 0">Account and mission updates are sent to the email on your Send a Scout account. You can change email alerts in your profile settings.<br><br>Need help? Email <a href="mailto:support@sendascout.com" style="color:#087f73;font-weight:700">support@sendascout.com</a>.</p></div></div></body></html>`;
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
      text: `${title}\n\n${body}${actionUrl ? `\n\n${actionUrl}` : ""}\n\nNeed help? Email support@sendascout.com.`,
    }),
  });
  const result = await response.json().catch(() => null) as {
    id?: string;
    message?: string;
    name?: string;
    code?: string;
  } | null;
  if (!response.ok) {
    const message = result?.message || `Email provider rejected the message (${response.status}).`;
    const providerCode = result?.name ?? result?.code;
    if (
      response.status === 408
      || response.status === 429
      || response.status >= 500
      || (response.status === 409 && providerCode === "concurrent_idempotent_requests")
    ) throw new Error(message);
    throw new EmailProviderRejectedError(message);
  }
  // A successful HTTP response without an ID has an unknown outcome. Keep the
  // durable attempt pending and reuse the same provider idempotency key.
  if (!result?.id) throw new Error("Email provider returned an ambiguous response without a message ID.");
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
  if (input.sendEmail !== false && recipient.emailNotificationsEnabled) deliveries.push(queueEmail(input));
  if (input.sendSms !== false && recipient.smsNotificationsEnabled && recipient.smsConsentedAt && recipient.phone && isSentConfigured()) deliveries.push(queueSms(input));
  await Promise.all(deliveries);
}

/**
 * Records a one-time event for each channel before contacting a provider. A
 * database-unique dedupe key is the concurrency authority when Vercel retries,
 * a Stripe callback overlaps the hourly worker, or a process resumes after the
 * row commit. `kind` must identify one unique business event for the recipient.
 */
export async function notifyUserOnce(
  input: NotificationInput,
  options: { stillEligible?: () => Promise<boolean> } = {},
) {
  const db = getDb();
  const [recipient] = await db.select({
    email: users.email,
    phone: users.phone,
    status: users.status,
    emailNotificationsEnabled: users.emailNotificationsEnabled,
    smsNotificationsEnabled: users.smsNotificationsEnabled,
    smsConsentedAt: users.smsConsentedAt,
  }).from(users).where(eq(users.id, input.recipientUserId)).limit(1);
  if (!recipient || recipient.status !== "active") return { created: false, emailQueued: false, smsQueued: false };
  if (options.stillEligible && !await options.stillEligible()) return { created: false, emailQueued: false, smsQueued: false };

  const includeEmail = input.sendEmail !== false && recipient.emailNotificationsEnabled;
  const includeSms = input.sendSms !== false
    && recipient.smsNotificationsEnabled
    && Boolean(recipient.smsConsentedAt && recipient.phone)
    && isSentConfigured();
  const missionId = input.missionId ?? null;
  const eventKey = notificationEventKey(input);
  const desired = [
    {
      recipientUserId: input.recipientUserId,
      missionId,
      channel: "in_app" as const,
      status: "sent" as const,
      kind: input.kind,
      dedupeKey: `${eventKey}:in_app`,
      title: input.title,
      body: input.body,
      actionLabel: input.actionLabel ?? null,
      actionUrl: input.actionUrl ?? null,
      sentAt: new Date(),
    },
    ...(includeEmail ? [{
      recipientUserId: input.recipientUserId,
      missionId,
      channel: "email" as const,
      status: "pending" as const,
      kind: input.kind,
      dedupeKey: `${eventKey}:email`,
      title: input.title,
      body: input.body,
      actionLabel: input.actionLabel ?? null,
      actionUrl: input.actionUrl ?? null,
      sentAt: null,
    }] : []),
    ...(includeSms ? [{
      recipientUserId: input.recipientUserId,
      missionId,
      channel: "sms" as const,
      status: "pending" as const,
      kind: input.kind,
      dedupeKey: `${eventKey}:sms`,
      title: input.title,
      body: input.body,
      actionLabel: input.actionLabel ?? null,
      actionUrl: input.actionUrl ?? null,
      sentAt: null,
    }] : []),
  ];
  const inserted = await db.insert(notifications).values(desired)
    .onConflictDoNothing({ target: notifications.dedupeKey })
    .returning({ id: notifications.id, channel: notifications.channel });
  const [storedEmail] = includeEmail
    ? await db.select({
      id: notifications.id,
      title: notifications.title,
      body: notifications.body,
      actionLabel: notifications.actionLabel,
      actionUrl: notifications.actionUrl,
      attemptCount: notifications.attemptCount,
      providerAttemptStartedAt: notifications.providerAttemptStartedAt,
      lastAttemptAt: notifications.lastAttemptAt,
    }).from(notifications).where(and(
      eq(notifications.dedupeKey, `${eventKey}:email`),
      eq(notifications.channel, "email"),
      eq(notifications.status, "pending"),
      isNull(notifications.providerMessageId),
    )).limit(1)
    : [];
  const [freshEmail] = storedEmail?.attemptCount === 0
    ? await db.update(notifications).set({
      title: input.title,
      body: input.body,
      actionLabel: input.actionLabel ?? null,
      actionUrl: input.actionUrl ?? null,
      error: null,
    }).where(and(
      eq(notifications.id, storedEmail.id),
      eq(notifications.status, "pending"),
      eq(notifications.attemptCount, 0),
      isNull(notifications.providerMessageId),
    )).returning({
      id: notifications.id,
      title: notifications.title,
      body: notifications.body,
      actionLabel: notifications.actionLabel,
      actionUrl: notifications.actionUrl,
      attemptCount: notifications.attemptCount,
      providerAttemptStartedAt: notifications.providerAttemptStartedAt,
      lastAttemptAt: notifications.lastAttemptAt,
    })
    : [];
  const email = freshEmail ?? storedEmail;
  const [storedSms] = includeSms
    ? await db.select({
      id: notifications.id,
      title: notifications.title,
      body: notifications.body,
      actionLabel: notifications.actionLabel,
      actionUrl: notifications.actionUrl,
      attemptCount: notifications.attemptCount,
      providerAttemptStartedAt: notifications.providerAttemptStartedAt,
      lastAttemptAt: notifications.lastAttemptAt,
    }).from(notifications).where(and(
      eq(notifications.dedupeKey, `${eventKey}:sms`),
      eq(notifications.channel, "sms"),
      eq(notifications.status, "pending"),
      isNull(notifications.providerMessageId),
    )).limit(1)
    : [];
  const [freshSms] = storedSms?.attemptCount === 0
    ? await db.update(notifications).set({
      title: input.title,
      body: input.body,
      actionLabel: input.actionLabel ?? null,
      actionUrl: input.actionUrl ?? null,
      error: null,
    }).where(and(
      eq(notifications.id, storedSms.id),
      eq(notifications.status, "pending"),
      eq(notifications.attemptCount, 0),
      isNull(notifications.providerMessageId),
    )).returning({
      id: notifications.id,
      title: notifications.title,
      body: notifications.body,
      actionLabel: notifications.actionLabel,
      actionUrl: notifications.actionUrl,
      attemptCount: notifications.attemptCount,
      providerAttemptStartedAt: notifications.providerAttemptStartedAt,
      lastAttemptAt: notifications.lastAttemptAt,
    })
    : [];
  const sms = freshSms ?? storedSms;
  if (options.stillEligible && !await options.stillEligible()) {
    const insertedExternalIds = inserted
      .filter((row) => row.channel === "email" || row.channel === "sms")
      .map((row) => row.id);
    const releasedExternal = insertedExternalIds.length
      ? await db.delete(notifications).where(and(
        inArray(notifications.id, insertedExternalIds),
        eq(notifications.status, "pending"),
        isNull(notifications.providerMessageId),
        eq(notifications.attemptCount, 0),
      )).returning({ id: notifications.id })
      : [];
    const insertedExternalSet = new Set(insertedExternalIds);
    const referencesUnownedExternal = [email?.id, sms?.id]
      .some((id) => id && !insertedExternalSet.has(id));
    if (releasedExternal.length === insertedExternalIds.length && !referencesUnownedExternal) {
      const insertedInAppIds = inserted.filter((row) => row.channel === "in_app").map((row) => row.id);
      if (insertedInAppIds.length) await db.delete(notifications).where(inArray(notifications.id, insertedInAppIds));
    }
    return { created: false, emailQueued: false, smsQueued: false };
  }
  const payloadChanged = (delivery: NonNullable<typeof email | typeof sms>) => delivery.title !== input.title
    || delivery.body !== input.body
    || delivery.actionLabel !== (input.actionLabel ?? null)
    || delivery.actionUrl !== (input.actionUrl ?? null);
  if (email && email.attemptCount > 0 && payloadChanged(email)) {
    await db.update(notifications).set({
      status: "failed",
      error: "Notification content changed before an ambiguous email attempt could be recovered safely.",
    }).where(and(
      eq(notifications.id, email.id),
      eq(notifications.status, "pending"),
      isNull(notifications.providerMessageId),
      eq(notifications.attemptCount, email.attemptCount),
      sql`${notifications.providerAttemptStartedAt} IS NOT DISTINCT FROM ${email.providerAttemptStartedAt}`,
      sql`${notifications.lastAttemptAt} IS NOT DISTINCT FROM ${email.lastAttemptAt}`,
    ));
  }
  if (sms && sms.attemptCount > 0 && payloadChanged(sms)) {
    await db.update(notifications).set({
      status: "failed",
      error: "Notification content changed before an ambiguous SMS attempt could be recovered safely.",
    }).where(and(
      eq(notifications.id, sms.id),
      eq(notifications.status, "pending"),
      isNull(notifications.providerMessageId),
      eq(notifications.attemptCount, sms.attemptCount),
      sql`${notifications.providerAttemptStartedAt} IS NOT DISTINCT FROM ${sms.providerAttemptStartedAt}`,
      sql`${notifications.lastAttemptAt} IS NOT DISTINCT FROM ${sms.lastAttemptAt}`,
    ));
  }
  const [emailQueued, smsQueued] = await Promise.all([
    email && !(email.attemptCount > 0 && payloadChanged(email))
      ? deliverClaimedEmailOnce({
      notificationId: email.id,
      kind: input.kind,
      title: input.title,
      body: input.body,
      actionLabel: input.actionLabel,
      actionUrl: input.actionUrl,
      recipientUserId: input.recipientUserId,
      stillEligible: options.stillEligible,
      cleanupNotificationIds: inserted.filter((row) => row.channel === "in_app").map((row) => row.id),
      initialAttemptCount: email.attemptCount,
    })
      : false,
    sms && recipient.phone && !(sms.attemptCount > 0 && payloadChanged(sms))
      ? deliverClaimedSmsOnce({
        notificationId: sms.id,
        phone: recipient.phone,
        kind: input.kind,
        title: input.title,
        body: input.body,
        actionUrl: input.actionUrl,
        recipientUserId: input.recipientUserId,
        stillEligible: options.stillEligible,
        cleanupNotificationIds: inserted.filter((row) => row.channel === "in_app").map((row) => row.id),
        initialAttemptCount: sms.attemptCount,
      })
      : false,
  ]);
  return {
    created: inserted.some((row) => row.channel === "in_app"),
    emailQueued,
    smsQueued,
  };
}

async function expireUnsafeAmbiguousReplay(notificationId: string, now: Date) {
  const replayCutoff = new Date(now.getTime() - PROVIDER_IDEMPOTENCY_REPLAY_WINDOW_MS);
  const leaseCutoff = new Date(now.getTime() - 5 * 60 * 1000);
  const [expired] = await getDb().update(notifications).set({
    status: "failed",
    error: OUTCOME_UNKNOWN_RECONCILIATION_ERROR,
  }).where(and(
    eq(notifications.id, notificationId),
    eq(notifications.status, "pending"),
    isNull(notifications.providerMessageId),
    sql`${notifications.attemptCount} > 0`,
    sql`(
      ${notifications.providerAttemptStartedAt} IS NULL
      OR ${notifications.providerAttemptStartedAt} <= ${replayCutoff}
    )`,
    sql`(
      ${notifications.lastAttemptAt} IS NULL
      OR ${notifications.lastAttemptAt} <= ${leaseCutoff}
    )`,
  )).returning({ id: notifications.id });
  return Boolean(expired);
}

function activeProviderAttemptLease(notificationId: string, attempt: number, leaseAt: Date) {
  return and(
    eq(notifications.id, notificationId),
    eq(notifications.status, "pending"),
    isNull(notifications.providerMessageId),
    eq(notifications.attemptCount, attempt),
    sql`${notifications.lastAttemptAt} IS NOT DISTINCT FROM ${leaseAt}`,
  );
}

async function currentEmailRecipientForLease(
  notificationId: string,
  recipientUserId: string,
  attempt: number,
  leaseAt: Date,
) {
  const [recipient] = await getDb().select({
    email: users.email,
    status: users.status,
    emailNotificationsEnabled: users.emailNotificationsEnabled,
  }).from(notifications)
    .innerJoin(users, eq(users.id, notifications.recipientUserId))
    .where(and(
      activeProviderAttemptLease(notificationId, attempt, leaseAt),
      eq(users.id, recipientUserId),
    )).limit(1);
  return recipient;
}

async function currentSmsRecipientForLease(
  notificationId: string,
  recipientUserId: string,
  attempt: number,
  leaseAt: Date,
) {
  const [recipient] = await getDb().select({
    phone: users.phone,
    status: users.status,
    smsNotificationsEnabled: users.smsNotificationsEnabled,
    smsConsentedAt: users.smsConsentedAt,
  }).from(notifications)
    .innerJoin(users, eq(users.id, notifications.recipientUserId))
    .where(and(
      activeProviderAttemptLease(notificationId, attempt, leaseAt),
      eq(users.id, recipientUserId),
    )).limit(1);
  return recipient;
}

async function deliverClaimedEmailOnce(input: {
  notificationId: string;
  kind: string;
  title: string;
  body: string;
  actionLabel?: string;
  actionUrl?: string;
  recipientUserId: string;
  stillEligible?: () => Promise<boolean>;
  cleanupNotificationIds: string[];
  initialAttemptCount: number;
}) {
  const db = getDb();
  const now = new Date();
  if (await expireUnsafeAmbiguousReplay(input.notificationId, now)) return false;
  const leaseCutoff = new Date(now.getTime() - 5 * 60 * 1000);
  const [started] = await db.update(notifications).set({
    attemptCount: sql`CASE WHEN ${notifications.attemptCount} = 0 THEN 1 ELSE ${notifications.attemptCount} END`,
    providerAttemptStartedAt: sql`CASE
      WHEN ${notifications.attemptCount} = 0 THEN ${now}
      ELSE ${notifications.providerAttemptStartedAt}
    END`,
    lastAttemptAt: now,
  }).where(and(
    eq(notifications.id, input.notificationId),
    eq(notifications.status, "pending"),
    isNull(notifications.providerMessageId),
    sql`(
      ${notifications.attemptCount} = 0
      OR ${notifications.lastAttemptAt} IS NULL
      OR ${notifications.lastAttemptAt} <= ${leaseCutoff}
    )`,
  )).returning({ attempt: notifications.attemptCount });
  if (!started) return false;
  const stillEligible = !input.stillEligible || await input.stillEligible();
  const currentRecipient = await currentEmailRecipientForLease(
    input.notificationId,
    input.recipientUserId,
    started.attempt,
    now,
  );
  if (!currentRecipient) return false;
  if (currentRecipient.status !== "active" || !stillEligible) {
    const released = input.initialAttemptCount === 0
      ? await db.delete(notifications).where(activeProviderAttemptLease(input.notificationId, started.attempt, now)).returning({ id: notifications.id })
      : await db.update(notifications).set({ status: "failed", error: "The Scout no longer needs this onboarding email." })
        .where(activeProviderAttemptLease(input.notificationId, started.attempt, now)).returning({ id: notifications.id });
    if (released.length && input.cleanupNotificationIds.length) {
      await db.delete(notifications).where(inArray(notifications.id, input.cleanupNotificationIds));
    }
    return false;
  }
  if (!currentRecipient.emailNotificationsEnabled) {
    if (input.initialAttemptCount === 0) {
      await db.delete(notifications).where(activeProviderAttemptLease(input.notificationId, started.attempt, now));
    } else {
      await db.update(notifications).set({ status: "failed", error: "The recipient disabled email notifications before recovery." })
        .where(activeProviderAttemptLease(input.notificationId, started.attempt, now));
    }
    return false;
  }
  try {
    const providerMessageId = await sendEmail(
      currentRecipient.email,
      input.title,
      input.body,
      input.notificationId,
      started.attempt,
      input.actionLabel,
      input.actionUrl,
    );
    await db.update(notifications).set({ providerMessageId, sentAt: null, error: null })
      .where(activeProviderAttemptLease(input.notificationId, started.attempt, now));
    console.info("Send a Scout one-time email accepted by provider", {
      notificationId: input.notificationId,
      kind: input.kind,
      providerMessageId,
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email delivery failed.";
    await db.update(notifications).set({ status: error instanceof EmailProviderRejectedError ? "failed" : "pending", error: message })
      .where(activeProviderAttemptLease(input.notificationId, started.attempt, now));
    console.warn("Send a Scout one-time email delivery failed", { kind: input.kind, error: message });
    return false;
  }
}

async function deliverClaimedSmsOnce(input: {
  notificationId: string;
  phone: string;
  kind: string;
  title: string;
  body: string;
  actionUrl?: string;
  recipientUserId: string;
  stillEligible?: () => Promise<boolean>;
  cleanupNotificationIds: string[];
  initialAttemptCount: number;
}) {
  const db = getDb();
  const now = new Date();
  if (await expireUnsafeAmbiguousReplay(input.notificationId, now)) return false;
  const leaseCutoff = new Date(now.getTime() - 5 * 60 * 1000);
  const [started] = await db.update(notifications).set({
    attemptCount: sql`CASE WHEN ${notifications.attemptCount} = 0 THEN 1 ELSE ${notifications.attemptCount} END`,
    providerAttemptStartedAt: sql`CASE
      WHEN ${notifications.attemptCount} = 0 THEN ${now}
      ELSE ${notifications.providerAttemptStartedAt}
    END`,
    lastAttemptAt: now,
  }).where(and(
    eq(notifications.id, input.notificationId),
    eq(notifications.status, "pending"),
    isNull(notifications.providerMessageId),
    sql`(
      ${notifications.attemptCount} = 0
      OR ${notifications.lastAttemptAt} IS NULL
      OR ${notifications.lastAttemptAt} <= ${leaseCutoff}
    )`,
  )).returning({ attempt: notifications.attemptCount });
  if (!started) return false;

  const [currentRecipient] = await db.select({
    status: users.status,
    phone: users.phone,
    smsNotificationsEnabled: users.smsNotificationsEnabled,
    smsConsentedAt: users.smsConsentedAt,
  }).from(users).where(eq(users.id, input.recipientUserId)).limit(1);
  const stillEligible = !input.stillEligible || await input.stillEligible();
  if (!currentRecipient || currentRecipient.status !== "active" || !stillEligible) {
    const released = input.initialAttemptCount === 0
      ? await db.delete(notifications).where(activeProviderAttemptLease(input.notificationId, started.attempt, now)).returning({ id: notifications.id })
      : await db.update(notifications).set({ status: "failed", error: "The recipient no longer needs this SMS alert." })
        .where(activeProviderAttemptLease(input.notificationId, started.attempt, now)).returning({ id: notifications.id });
    if (released.length && input.cleanupNotificationIds.length) {
      await db.delete(notifications).where(inArray(notifications.id, input.cleanupNotificationIds));
    }
    return false;
  }
  if (!currentRecipient.smsNotificationsEnabled || !currentRecipient.smsConsentedAt || !currentRecipient.phone) {
    if (input.initialAttemptCount === 0) {
      await db.delete(notifications).where(activeProviderAttemptLease(input.notificationId, started.attempt, now));
    } else {
      await db.update(notifications).set({ status: "failed", error: "The recipient disabled SMS alerts before recovery." })
        .where(activeProviderAttemptLease(input.notificationId, started.attempt, now));
    }
    return false;
  }
  let providerMessageId: string;
  try {
    providerMessageId = await sendSentSms({
      notificationId: input.notificationId,
      attempt: started.attempt,
      to: currentRecipient.phone,
      title: input.title,
      body: input.body,
      actionUrl: input.actionUrl,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "SMS delivery failed.";
    await db.update(notifications).set({
      status: isSentSmsErrorRetryable(error) ? "pending" : "failed",
      error: message,
    }).where(activeProviderAttemptLease(input.notificationId, started.attempt, now));
    console.warn("Send a Scout one-time SMS delivery failed", { kind: input.kind, error: message });
    return false;
  }
  try {
    await db.update(notifications).set({ providerMessageId, sentAt: null, error: null })
      .where(activeProviderAttemptLease(input.notificationId, started.attempt, now));
    await applyStoredSentMessageEvent(providerMessageId);
    console.info("Send a Scout one-time SMS accepted by provider", {
      notificationId: input.notificationId,
      kind: input.kind,
      providerMessageId,
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sent accepted the text, but its delivery mapping is still being reconciled.";
    await db.update(notifications).set({
      status: "pending",
      error: `Sent accepted the text; delivery mapping recovery is pending. ${message}`,
    }).where(activeProviderAttemptLease(input.notificationId, started.attempt, now));
    console.error("Accepted Sent SMS mapping failed", { notificationId: input.notificationId, kind: input.kind, error: message });
    return false;
  }
}

async function queueEmail(input: NotificationInput) {
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
  const attemptStartedAt = new Date();
  const [started] = await db.update(notifications).set({
    attemptCount: sql`${notifications.attemptCount} + 1`,
    providerAttemptStartedAt: attemptStartedAt,
    lastAttemptAt: attemptStartedAt,
  }).where(eq(notifications.id, queued.id)).returning({ attempt: notifications.attemptCount });
  if (!started) throw new Error("Email notification attempt could not be started.");
  const currentRecipient = await currentEmailRecipientForLease(
    queued.id,
    input.recipientUserId,
    started.attempt,
    attemptStartedAt,
  );
  if (!currentRecipient) return;
  if (currentRecipient.status !== "active" || !currentRecipient.emailNotificationsEnabled) {
    const reason = currentRecipient.status !== "active"
      ? "The recipient account is not active."
      : "The recipient disabled email notifications before delivery.";
    await db.update(notifications).set({ status: "failed", error: reason })
      .where(activeProviderAttemptLease(queued.id, started.attempt, attemptStartedAt));
    return;
  }
  let providerMessageId: string;
  try {
    providerMessageId = await sendEmail(currentRecipient.email, input.title, input.body, queued.id, started.attempt, input.actionLabel, input.actionUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email delivery failed.";
    await db.update(notifications).set({ status: error instanceof EmailProviderRejectedError ? "failed" : "pending", error: message })
      .where(activeProviderAttemptLease(queued.id, started.attempt, attemptStartedAt));
    console.warn("Send a Scout email delivery failed", { kind: input.kind, error: message });
    return;
  }
  try {
    await db.update(notifications).set({ providerMessageId, sentAt: null, error: null })
      .where(activeProviderAttemptLease(queued.id, started.attempt, attemptStartedAt));
    console.info("Send a Scout email accepted by provider", {
      notificationId: queued.id,
      kind: input.kind,
      attempt: started.attempt,
      providerMessageId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email provider accepted the message, but its delivery mapping is still being reconciled.";
    await db.update(notifications).set({
      status: "pending",
      error: `Email provider accepted the message; delivery mapping recovery is pending. ${message}`,
    }).where(activeProviderAttemptLease(queued.id, started.attempt, attemptStartedAt));
    console.error("Accepted email mapping failed", { notificationId: queued.id, kind: input.kind, error: message });
  }
}

async function queueSms(input: NotificationInput) {
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
  const attemptStartedAt = new Date();
  const [started] = await db.update(notifications).set({
    attemptCount: sql`${notifications.attemptCount} + 1`,
    providerAttemptStartedAt: attemptStartedAt,
    lastAttemptAt: attemptStartedAt,
  }).where(eq(notifications.id, queued.id)).returning({ attempt: notifications.attemptCount });
  if (!started) throw new Error("SMS notification attempt could not be started.");
  const currentRecipient = await currentSmsRecipientForLease(
    queued.id,
    input.recipientUserId,
    started.attempt,
    attemptStartedAt,
  );
  if (!currentRecipient) return;
  if (
    currentRecipient.status !== "active"
    || !currentRecipient.smsNotificationsEnabled
    || !currentRecipient.smsConsentedAt
    || !currentRecipient.phone
  ) {
    const reason = currentRecipient.status !== "active"
      ? "The recipient account is not active."
      : !currentRecipient.smsNotificationsEnabled || !currentRecipient.smsConsentedAt
        ? "The recipient disabled SMS notifications before delivery."
        : "The recipient does not have a mobile number.";
    await db.update(notifications).set({ status: "failed", error: reason })
      .where(activeProviderAttemptLease(queued.id, started.attempt, attemptStartedAt));
    return;
  }
  let providerMessageId: string;
  try {
    providerMessageId = await sendSentSms({ notificationId: queued.id, attempt: started.attempt, to: currentRecipient.phone, title: input.title, body: input.body, actionUrl: input.actionUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : "SMS delivery failed.";
    await db.update(notifications).set({ status: isSentSmsErrorRetryable(error) ? "pending" : "failed", error: message })
      .where(activeProviderAttemptLease(queued.id, started.attempt, attemptStartedAt));
    console.warn("Send a Scout SMS delivery failed", { kind: input.kind, error: message });
    return;
  }
  try {
    await db.update(notifications).set({ providerMessageId, error: null })
      .where(activeProviderAttemptLease(queued.id, started.attempt, attemptStartedAt));
    await applyStoredSentMessageEvent(providerMessageId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sent accepted the text, but its delivery mapping is still being reconciled.";
    await db.update(notifications).set({
      status: "pending",
      error: `Sent accepted the text; delivery mapping recovery is pending. ${message}`,
    }).where(activeProviderAttemptLease(queued.id, started.attempt, attemptStartedAt));
    console.error("Accepted Sent SMS mapping failed", { notificationId: queued.id, kind: input.kind, error: message });
  }
}

type EmailRetryItem = {
  id: string;
  channel: "in_app" | "email" | "sms";
  status: "pending" | "sent" | "failed";
  title: string;
  body: string;
  actionLabel: string | null;
  actionUrl: string | null;
  kind: string;
  recipientUserId: string;
  missionId: string | null;
  dedupeKey: string | null;
};

type EmailRetryPayload = Pick<EmailRetryItem, "title" | "body" | "actionLabel" | "actionUrl">;

function sameEmailPayload(left: EmailRetryPayload, right: EmailRetryPayload) {
  return left.title === right.title
    && left.body === right.body
    && left.actionLabel === right.actionLabel
    && left.actionUrl === right.actionUrl;
}

async function currentEmailRetryPayload(item: EmailRetryItem): Promise<EmailRetryPayload> {
  if (isScoutOnboardingNotificationKind(item.kind)) {
    const current = await loadActiveScoutOnboarding(item.recipientUserId);
    if (!current) throw new Error("This Scout no longer needs an onboarding reminder.");
    const progress = onboardingProgressFor(current);
    if (progress.ready || !progress.nextStep) throw new Error("This Scout no longer needs an onboarding reminder.");
    return {
      title: item.title,
      body: scoutOnboardingReminderBody(progress),
      actionLabel: progress.nextStep.actionLabel,
      actionUrl: new URL(progress.nextStep.href, `${getAppUrl()}/`).toString(),
    };
  }
  if (item.kind === "scout_approved") {
    const [ready] = await getDb().select({ userId: users.id })
      .from(scoutProfiles)
      .innerJoin(users, eq(users.id, scoutProfiles.userId))
      .where(and(
        eq(users.id, item.recipientUserId),
        ...scoutClaimReadinessConditions(getStripeLivemode()),
      )).limit(1);
    if (!ready) throw new Error("This Scout is no longer approved and ready to claim missions.");
  }
  if (item.kind === "new_mission") {
    if (!item.missionId) throw new Error("This mission alert no longer has a valid mission.");
    const [mission] = await getDb().select().from(missions).where(eq(missions.id, item.missionId)).limit(1);
    if (!mission) throw new Error("This mission no longer exists.");
    const alertTarget = missionAlertTarget(mission, item.recipientUserId);
    const scope = alertTarget.scope;
    const expectedDedupeKey = `${notificationEventKey({
      recipientUserId: item.recipientUserId,
      missionId: item.missionId,
      kind: item.kind,
      dedupeScope: scope,
    })}:${item.channel}`;
    let belongsToCurrentPublication = item.dedupeKey
      ? item.dedupeKey === expectedDedupeKey
      : false;
    if (!item.dedupeKey && alertTarget.generation === 0) {
      await adoptLegacyMissionAlertKeys(
        item.recipientUserId,
        item.missionId,
        scope,
        alertTarget.generation,
      );
      const [canonicalLegacyDelivery] = await getDb().select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.dedupeKey, expectedDedupeKey))
        .limit(1);
      belongsToCurrentPublication = canonicalLegacyDelivery?.id === item.id;
    }
    if (!belongsToCurrentPublication || !await scoutStillEligibleForMissionAlert(item.recipientUserId, item.missionId, scope)) {
      throw new Error("This Scout or mission is no longer eligible for this alert.");
    }
  }
  return {
    title: item.title,
    body: item.body,
    actionLabel: item.actionLabel,
    actionUrl: item.actionUrl,
  };
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
    recipientUserId: notifications.recipientUserId,
    missionId: notifications.missionId,
    dedupeKey: notifications.dedupeKey,
    attemptCount: notifications.attemptCount,
    providerMessageId: notifications.providerMessageId,
    providerAttemptStartedAt: notifications.providerAttemptStartedAt,
    lastAttemptAt: notifications.lastAttemptAt,
    error: notifications.error,
    enabled: users.emailNotificationsEnabled,
    userStatus: users.status,
  }).from(notifications).innerJoin(users, eq(users.id, notifications.recipientUserId))
    .where(eq(notifications.id, notificationId)).limit(1);
  if (!item || item.channel !== "email") throw new Error("Email notification not found.");
  if (item.userStatus !== "active") throw new Error("The recipient account is not active.");
  if (!item.enabled) throw new Error("The recipient has disabled email notifications.");
  if (item.error === OUTCOME_UNKNOWN_RECONCILIATION_ERROR) throw new Error(OUTCOME_UNKNOWN_RECONCILIATION_ERROR);
  const ambiguousAttempt = item.status === "pending" && !item.providerMessageId && item.attemptCount > 0;
  const leaseCutoff = Date.now() - 5 * 60 * 1000;
  if (ambiguousAttempt && item.lastAttemptAt && item.lastAttemptAt.getTime() > leaseCutoff) {
    throw new Error("This email attempt is still being reconciled. Try again in a few minutes.");
  }
  const replayCutoff = Date.now() - PROVIDER_IDEMPOTENCY_REPLAY_WINDOW_MS;
  if (ambiguousAttempt && (!item.providerAttemptStartedAt || item.providerAttemptStartedAt.getTime() <= replayCutoff)) {
    await db.update(notifications).set({ status: "failed", error: OUTCOME_UNKNOWN_RECONCILIATION_ERROR }).where(and(
      eq(notifications.id, item.id),
      eq(notifications.status, item.status),
      eq(notifications.attemptCount, item.attemptCount),
      sql`${notifications.providerMessageId} IS NOT DISTINCT FROM ${item.providerMessageId}`,
      sql`${notifications.providerAttemptStartedAt} IS NOT DISTINCT FROM ${item.providerAttemptStartedAt}`,
      sql`${notifications.lastAttemptAt} IS NOT DISTINCT FROM ${item.lastAttemptAt}`,
    ));
    throw new Error(OUTCOME_UNKNOWN_RECONCILIATION_ERROR);
  }
  const storedPayload: EmailRetryPayload = {
    title: item.title,
    body: item.body,
    actionLabel: item.actionLabel,
    actionUrl: item.actionUrl,
  };
  const currentPayload = await currentEmailRetryPayload(item);
  if (ambiguousAttempt && !sameEmailPayload(storedPayload, currentPayload)) {
    throw new Error("The Scout’s onboarding progress changed after this email attempt. Wait for the current tracker email instead of replaying stale content.");
  }
  const sendPayload = ambiguousAttempt ? storedPayload : currentPayload;

  const attemptLeaseAt = new Date();
  const [started] = await db.update(notifications).set({
    status: "pending",
    error: null,
    providerMessageId: null,
    sentAt: null,
    title: sendPayload.title,
    body: sendPayload.body,
    actionLabel: sendPayload.actionLabel,
    actionUrl: sendPayload.actionUrl,
    attemptCount: ambiguousAttempt ? notifications.attemptCount : sql`${notifications.attemptCount} + 1`,
    providerAttemptStartedAt: ambiguousAttempt ? notifications.providerAttemptStartedAt : attemptLeaseAt,
    lastAttemptAt: attemptLeaseAt,
  }).where(and(
    eq(notifications.id, item.id),
    eq(notifications.status, item.status),
    eq(notifications.attemptCount, item.attemptCount),
    sql`${notifications.providerMessageId} IS NOT DISTINCT FROM ${item.providerMessageId}`,
    sql`${notifications.providerAttemptStartedAt} IS NOT DISTINCT FROM ${item.providerAttemptStartedAt}`,
    sql`${notifications.lastAttemptAt} IS NOT DISTINCT FROM ${item.lastAttemptAt}`,
  )).returning({ attempt: notifications.attemptCount });
  if (!started) throw new Error("Email notification attempt could not be started.");
  let finalPayload: EmailRetryPayload | null = null;
  try {
    finalPayload = await currentEmailRetryPayload({ ...item, ...sendPayload });
  } catch {
    finalPayload = null;
  }
  const currentRecipient = await currentEmailRecipientForLease(
    item.id,
    item.recipientUserId,
    started.attempt,
    attemptLeaseAt,
  );
  if (!currentRecipient) throw new Error("Email notification attempt is no longer active.");
  if (currentRecipient.status !== "active" || !currentRecipient.emailNotificationsEnabled || !finalPayload || !sameEmailPayload(sendPayload, finalPayload)) {
    const reason = currentRecipient.status !== "active"
      ? "The recipient account is not active."
      : !currentRecipient.emailNotificationsEnabled
        ? "The recipient has disabled email notifications."
        : !finalPayload
          ? item.kind === "scout_approved"
            ? "This Scout is no longer approved and ready to claim missions."
            : "This Scout no longer needs an onboarding reminder."
          : "The notification content changed before the email could be sent.";
    await db.update(notifications).set({ status: "failed", error: reason })
      .where(activeProviderAttemptLease(item.id, started.attempt, attemptLeaseAt));
    throw new Error(reason);
  }
  try {
    const providerMessageId = await sendEmail(
      currentRecipient.email,
      sendPayload.title,
      sendPayload.body,
      item.id,
      started.attempt,
      sendPayload.actionLabel ?? undefined,
      sendPayload.actionUrl ?? undefined,
    );
    await db.update(notifications).set({ providerMessageId, sentAt: null, error: null })
      .where(activeProviderAttemptLease(item.id, started.attempt, attemptLeaseAt));
    console.info("Send a Scout email accepted by provider", {
      notificationId: item.id,
      kind: item.kind,
      attempt: started.attempt,
      providerMessageId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email delivery failed.";
    await db.update(notifications).set({ status: error instanceof EmailProviderRejectedError ? "failed" : "pending", error: message })
      .where(activeProviderAttemptLease(item.id, started.attempt, attemptLeaseAt));
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
    actionLabel: notifications.actionLabel,
    actionUrl: notifications.actionUrl,
    kind: notifications.kind,
    recipientUserId: notifications.recipientUserId,
    missionId: notifications.missionId,
    dedupeKey: notifications.dedupeKey,
    attemptCount: notifications.attemptCount,
    providerMessageId: notifications.providerMessageId,
    providerAttemptStartedAt: notifications.providerAttemptStartedAt,
    lastAttemptAt: notifications.lastAttemptAt,
    error: notifications.error,
    phone: users.phone,
    enabled: users.smsNotificationsEnabled,
    consentedAt: users.smsConsentedAt,
    userStatus: users.status,
  }).from(notifications).innerJoin(users, eq(users.id, notifications.recipientUserId))
    .where(eq(notifications.id, notificationId)).limit(1);
  if (!item || item.channel !== "sms") throw new Error("SMS notification not found.");
  if (item.status === "sent") throw new Error("This text was already delivered.");
  if (item.status === "pending" && item.providerMessageId) throw new Error("This text was accepted by Sent and is awaiting a delivery result. Do not retry it yet.");
  if (item.userStatus !== "active") throw new Error("The recipient account is not active.");
  if (!item.enabled || !item.consentedAt) throw new Error("The recipient has not enabled text notifications.");
  if (!item.phone) throw new Error("The recipient does not have a mobile number.");
  if (!isSentConfigured()) throw new Error("Sent SMS delivery is not configured.");
  if (item.error === OUTCOME_UNKNOWN_RECONCILIATION_ERROR) throw new Error(OUTCOME_UNKNOWN_RECONCILIATION_ERROR);
  const ambiguousAttempt = item.status === "pending" && !item.providerMessageId && item.attemptCount > 0;
  const leaseCutoff = Date.now() - 5 * 60 * 1000;
  if (ambiguousAttempt && item.lastAttemptAt && item.lastAttemptAt.getTime() > leaseCutoff) {
    throw new Error("This text attempt is still being reconciled. Try again in a few minutes.");
  }
  const replayCutoff = Date.now() - PROVIDER_IDEMPOTENCY_REPLAY_WINDOW_MS;
  if (ambiguousAttempt && (!item.providerAttemptStartedAt || item.providerAttemptStartedAt.getTime() <= replayCutoff)) {
    await db.update(notifications).set({ status: "failed", error: OUTCOME_UNKNOWN_RECONCILIATION_ERROR }).where(and(
      eq(notifications.id, item.id),
      eq(notifications.status, item.status),
      eq(notifications.attemptCount, item.attemptCount),
      sql`${notifications.providerMessageId} IS NOT DISTINCT FROM ${item.providerMessageId}`,
      sql`${notifications.providerAttemptStartedAt} IS NOT DISTINCT FROM ${item.providerAttemptStartedAt}`,
      sql`${notifications.lastAttemptAt} IS NOT DISTINCT FROM ${item.lastAttemptAt}`,
    ));
    throw new Error(OUTCOME_UNKNOWN_RECONCILIATION_ERROR);
  }
  const currentPayload = await currentEmailRetryPayload({
    id: item.id,
    channel: item.channel,
    status: item.status,
    title: item.title,
    body: item.body,
    actionLabel: item.actionLabel,
    actionUrl: item.actionUrl,
    kind: item.kind,
    recipientUserId: item.recipientUserId,
    missionId: item.missionId,
    dedupeKey: item.dedupeKey,
  });
  const storedPayload: EmailRetryPayload = {
    title: item.title,
    body: item.body,
    actionLabel: item.actionLabel,
    actionUrl: item.actionUrl,
  };
  if (ambiguousAttempt && !sameEmailPayload(storedPayload, currentPayload)) {
    throw new Error("The notification content changed after this text attempt. Wait for the current alert instead of replaying stale content.");
  }
  const sendPayload = ambiguousAttempt ? storedPayload : currentPayload;

  const attemptStartedAt = new Date();
  const [started] = await db.update(notifications).set({
    status: "pending",
    error: null,
    providerMessageId: null,
    title: sendPayload.title,
    body: sendPayload.body,
    actionLabel: sendPayload.actionLabel,
    actionUrl: sendPayload.actionUrl,
    attemptCount: ambiguousAttempt ? notifications.attemptCount : sql`${notifications.attemptCount} + 1`,
    providerAttemptStartedAt: ambiguousAttempt ? notifications.providerAttemptStartedAt : attemptStartedAt,
    lastAttemptAt: attemptStartedAt,
  }).where(and(
    eq(notifications.id, item.id),
    eq(notifications.status, item.status),
    eq(notifications.attemptCount, item.attemptCount),
    sql`${notifications.providerMessageId} IS NOT DISTINCT FROM ${item.providerMessageId}`,
    sql`${notifications.providerAttemptStartedAt} IS NOT DISTINCT FROM ${item.providerAttemptStartedAt}`,
    sql`${notifications.lastAttemptAt} IS NOT DISTINCT FROM ${item.lastAttemptAt}`,
  )).returning({ attempt: notifications.attemptCount });
  if (!started) throw new Error("SMS notification attempt could not be started.");
  let finalPayload: EmailRetryPayload | null = null;
  try {
    finalPayload = await currentEmailRetryPayload({ ...item, ...sendPayload });
  } catch {
    finalPayload = null;
  }
  const currentRecipient = await currentSmsRecipientForLease(
    item.id,
    item.recipientUserId,
    started.attempt,
    attemptStartedAt,
  );
  if (!currentRecipient) throw new Error("SMS notification attempt is no longer active.");
  if (
    currentRecipient.status !== "active"
    || !currentRecipient.smsNotificationsEnabled
    || !currentRecipient.smsConsentedAt
    || !currentRecipient.phone
    || !finalPayload
    || !sameEmailPayload(sendPayload, finalPayload)
  ) {
    const reason = currentRecipient.status !== "active"
      ? "The recipient account is not active."
      : !currentRecipient.smsNotificationsEnabled || !currentRecipient.smsConsentedAt
        ? "The recipient has not enabled text notifications."
        : !currentRecipient.phone
          ? "The recipient does not have a mobile number."
          : !finalPayload
            ? item.kind === "scout_approved"
              ? "This Scout is no longer approved and ready to claim missions."
              : "This Scout no longer needs this notification."
            : "The notification content changed before the text could be sent.";
    await db.update(notifications).set({ status: "failed", error: reason })
      .where(activeProviderAttemptLease(item.id, started.attempt, attemptStartedAt));
    throw new Error(reason);
  }
  let providerMessageId: string;
  try {
    providerMessageId = await sendSentSms({
      notificationId: item.id,
      attempt: started.attempt,
      to: currentRecipient.phone,
      title: sendPayload.title,
      body: sendPayload.body,
      actionUrl: sendPayload.actionUrl,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "SMS delivery failed.";
    await db.update(notifications).set({ status: isSentSmsErrorRetryable(error) ? "pending" : "failed", error: message })
      .where(activeProviderAttemptLease(item.id, started.attempt, attemptStartedAt));
    throw new Error(message);
  }
  try {
    await db.update(notifications).set({ providerMessageId, error: null })
      .where(activeProviderAttemptLease(item.id, started.attempt, attemptStartedAt));
    await applyStoredSentMessageEvent(providerMessageId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sent accepted the text, but its delivery mapping is still being reconciled.";
    await db.update(notifications).set({
      status: "pending",
      error: `Sent accepted the text; delivery mapping recovery is pending. ${message}`,
    }).where(activeProviderAttemptLease(item.id, started.attempt, attemptStartedAt));
    throw new Error("Sent accepted the text, but its delivery status is still being reconciled. Do not retry it yet.");
  }
}

export async function retryNotification(notificationId: string) {
  const [item] = await getDb().select({ channel: notifications.channel }).from(notifications).where(eq(notifications.id, notificationId)).limit(1);
  if (!item) throw new Error("Notification not found.");
  if (item.channel === "email") return retryEmailNotification(notificationId);
  if (item.channel === "sms") return retrySmsNotification(notificationId);
  throw new Error("In-app notifications cannot be retried.");
}

const CLAIM_NOTIFICATION_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

type ClaimedMissionNotificationCandidate = {
  mission_id: string;
  customer_id: string;
  scout_id: string;
  claimed_at: string | Date;
  bundle_leg_count: number;
};

async function claimedMissionNotificationStillEligible(
  candidate: ClaimedMissionNotificationCandidate,
  recoveryCutoff: Date,
) {
  const result = await getDb().execute<{ eligible: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM missions AS current_claim
      WHERE current_claim.id = ${candidate.mission_id}
        AND current_claim.customer_id = ${candidate.customer_id}
        AND current_claim.scout_id = ${candidate.scout_id}
        AND current_claim.claimed_at = ${candidate.claimed_at}
        AND current_claim.claimed_at >= ${recoveryCutoff}
        AND current_claim.archived_at IS NULL
        AND current_claim.status IN (
          'claimed',
          'en_route',
          'onsite',
          'en_route_pickup',
          'at_pickup',
          'en_route_dropoff',
          'at_dropoff'
        )
    ) AS eligible
  `);
  return Boolean(result.rows[0]?.eligible);
}

/**
 * Recovers customer delivery rows from the claim checkpoint that is committed
 * in the same SQL statement as the mission assignment. Calling
 * `notifyUserOnce` again is safe: its channel keys are unique, and ambiguous
 * provider attempts retain the same provider idempotency key.
 */
export async function reconcileClaimedMissionNotifications(limit = 100) {
  const boundedLimit = Math.max(1, Math.min(250, Math.trunc(limit)));
  const smsConfigured = isSentConfigured();
  const now = new Date();
  const recoveryCutoff = new Date(now.getTime() - CLAIM_NOTIFICATION_RECOVERY_WINDOW_MS);
  const leaseCutoff = new Date(now.getTime() - 5 * 60 * 1000);
  const db = getDb();
  const retiredResult = await db.execute<{ id: string }>(sql`
    UPDATE notifications AS stale_notice
    SET status = 'failed'::notification_status,
        error = 'The mission claim is no longer active or recent enough to recover this notification.'
    FROM missions AS stale_mission
    WHERE stale_notice.mission_id = stale_mission.id
      AND stale_notice.kind = 'mission_claimed'
      AND stale_notice.channel IN ('email', 'sms')
      AND stale_notice.status = 'pending'
      AND stale_notice.provider_message_id IS NULL
      AND (
        stale_notice.attempt_count = 0
        OR stale_notice.last_attempt_at IS NULL
        OR stale_notice.last_attempt_at <= ${leaseCutoff}
      )
      AND (
        stale_mission.customer_id <> stale_notice.recipient_user_id
        OR stale_mission.scout_id IS NULL
        OR stale_mission.claimed_at IS NULL
        OR stale_mission.claimed_at < ${recoveryCutoff}
        OR stale_mission.archived_at IS NOT NULL
        OR stale_mission.status NOT IN (
          'claimed',
          'en_route',
          'onsite',
          'en_route_pickup',
          'at_pickup',
          'en_route_dropoff',
          'at_dropoff'
        )
      )
    RETURNING stale_notice.id
  `);
  const result = await db.execute<ClaimedMissionNotificationCandidate>(sql`
    SELECT claimed.id AS mission_id,
      claimed.customer_id,
      claimed.scout_id,
      claimed.claimed_at,
      CASE
        WHEN claimed.bundle_id IS NULL THEN 1
        ELSE (
          SELECT COUNT(*)::integer
          FROM missions AS bundle_leg
          WHERE bundle_leg.bundle_id = claimed.bundle_id
            AND bundle_leg.archived_at IS NULL
        )
      END AS bundle_leg_count
    FROM missions AS claimed
    INNER JOIN users AS recipient ON recipient.id = claimed.customer_id
    WHERE claimed.scout_id IS NOT NULL
      AND claimed.claimed_at IS NOT NULL
      AND claimed.claimed_at >= ${recoveryCutoff}
      AND claimed.archived_at IS NULL
      AND claimed.status IN (
        'claimed',
        'en_route',
        'onsite',
        'en_route_pickup',
        'at_pickup',
        'en_route_dropoff',
        'at_dropoff'
      )
      AND (claimed.bundle_id IS NULL OR claimed.bundle_sequence = 1)
      AND recipient.status = 'active'
      AND EXISTS (
        SELECT 1
        FROM mission_updates AS claim_audit
        WHERE claim_audit.mission_id = claimed.id
          AND claim_audit.author_id = claimed.scout_id
          AND claim_audit.status = 'claimed'
      )
      AND EXISTS (
        SELECT 1
        FROM notifications AS checkpoint
        WHERE checkpoint.recipient_user_id = claimed.customer_id
          AND checkpoint.mission_id = claimed.id
          AND checkpoint.channel = 'in_app'
          AND checkpoint.status = 'sent'
          AND checkpoint.kind = 'mission_claimed'
          AND checkpoint.dedupe_key IS NOT NULL
      )
      AND (
        (
          recipient.email_notifications_enabled = TRUE
          AND (
            NOT EXISTS (
              SELECT 1 FROM notifications AS email_notice
              WHERE email_notice.recipient_user_id = claimed.customer_id
                AND email_notice.mission_id = claimed.id
                AND email_notice.kind = 'mission_claimed'
                AND email_notice.channel = 'email'
            )
            OR EXISTS (
              SELECT 1 FROM notifications AS pending_email
              WHERE pending_email.recipient_user_id = claimed.customer_id
                AND pending_email.mission_id = claimed.id
                AND pending_email.kind = 'mission_claimed'
                AND pending_email.channel = 'email'
                AND pending_email.status = 'pending'
                AND pending_email.provider_message_id IS NULL
            )
          )
        )
        OR (
          ${smsConfigured}
          AND recipient.sms_notifications_enabled = TRUE
          AND recipient.sms_consented_at IS NOT NULL
          AND recipient.phone IS NOT NULL
          AND (
            NOT EXISTS (
              SELECT 1 FROM notifications AS sms_notice
              WHERE sms_notice.recipient_user_id = claimed.customer_id
                AND sms_notice.mission_id = claimed.id
                AND sms_notice.kind = 'mission_claimed'
                AND sms_notice.channel = 'sms'
            )
            OR EXISTS (
              SELECT 1 FROM notifications AS pending_sms
              WHERE pending_sms.recipient_user_id = claimed.customer_id
                AND pending_sms.mission_id = claimed.id
                AND pending_sms.kind = 'mission_claimed'
                AND pending_sms.channel = 'sms'
                AND pending_sms.status = 'pending'
                AND pending_sms.provider_message_id IS NULL
            )
          )
        )
      )
    ORDER BY claimed.claimed_at, claimed.id
    LIMIT ${boundedLimit}
  `);

  let recovered = 0;
  let errors = 0;
  for (const candidate of result.rows) {
    try {
      const delivery = await notifyUserOnce(missionClaimedNotificationInput({
        customerUserId: candidate.customer_id,
        missionId: candidate.mission_id,
        bundleLegCount: Number(candidate.bundle_leg_count),
      }), {
        stillEligible: () => claimedMissionNotificationStillEligible(candidate, recoveryCutoff),
      });
      if (delivery.emailQueued || delivery.smsQueued) recovered += 1;
    } catch (error) {
      errors += 1;
      console.error("Claimed mission customer notification recovery failed", {
        missionId: candidate.mission_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { found: result.rows.length, recovered, retired: retiredResult.rows.length, errors };
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
      ...scoutClaimReadinessConditions(stripeLivemode),
    ));
  const eligibleScouts = scoutRows.filter((scout) => legs.every((leg) => isMissionEligibleForScout(leg, scout)));

  const preferredOnly = preferredAlertIsExclusive(mission);
  const scouts = preferredOnly
    ? eligibleScouts.filter((scout) => scout.userId === mission.preferredScoutId)
    : eligibleScouts;

  await Promise.all(scouts.map(async (scout) => {
    const target = missionAlertTarget(mission, scout.userId);
    await adoptLegacyMissionAlertKeys(scout.userId, mission.id, target.scope, target.generation);
    const copy = missionAlertCopy(mission, legs, bundle, target.preferredCopy);
    await notifyUserOnce({
      recipientUserId: scout.userId,
      missionId,
      kind: "new_mission",
      dedupeScope: target.scope,
      ...copy,
    }, {
      stillEligible: () => scoutStillEligibleForMissionAlert(scout.userId, mission.id, target.scope),
    });
  }));
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
    ...scoutClaimReadinessConditions(stripeLivemode),
  )).limit(1);
  if (!scout) return 0;

  const openRows = await db.select().from(missions)
    .where(and(eq(missions.status, "open"), eq(missions.paymentStatus, "paid"), sql`${missions.archivedAt} IS NULL`))
    .orderBy(asc(missions.createdAt));
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
  const candidates = roots.filter((mission) => {
    const preferredOnly = preferredAlertIsExclusive(mission);
    if (preferredOnly && mission.preferredScoutId !== scoutUserId) return false;
    if (mission.bundleId && bundleById.get(mission.bundleId)?.paymentStatus !== "paid") return false;
    const legs = mission.bundleId ? legsByBundle.get(mission.bundleId) ?? [mission] : [mission];
    return legs.every((leg) => isMissionEligibleForScout(leg, scout));
  });

  const validDeliveryKeys = new Set(candidates.flatMap((mission) => {
    const target = missionAlertTarget(mission, scoutUserId);
    const eventKey = notificationEventKey({
      recipientUserId: scoutUserId,
      missionId: mission.id,
      kind: "new_mission",
      dedupeScope: target.scope,
    });
    return [`${eventKey}:email`, `${eventKey}:sms`];
  }));
  const staleAlertLeaseCutoff = new Date(Date.now() - 5 * 60 * 1000);
  const recoverableAlerts = await db.select({
    id: notifications.id,
    dedupeKey: notifications.dedupeKey,
  }).from(notifications).where(and(
    eq(notifications.recipientUserId, scoutUserId),
    eq(notifications.kind, "new_mission"),
    inArray(notifications.channel, ["email", "sms"]),
    eq(notifications.status, "pending"),
    isNull(notifications.providerMessageId),
  ));
  const staleAlertIds = recoverableAlerts
    // NULL keys belong to the pre-dedupe generation. Preserve them as proof
    // that the legacy business event already happened instead of replaying it.
    .filter((alert) => alert.dedupeKey && !validDeliveryKeys.has(alert.dedupeKey))
    .map((alert) => alert.id);
  if (staleAlertIds.length) {
    await db.update(notifications).set({
      status: "failed",
      error: "The Scout or mission was no longer eligible when this alert was recovered.",
    }).where(and(
      inArray(notifications.id, staleAlertIds),
      eq(notifications.status, "pending"),
      isNull(notifications.providerMessageId),
      sql`(
        ${notifications.attemptCount} = 0
        OR ${notifications.lastAttemptAt} IS NULL
        OR ${notifications.lastAttemptAt} <= ${staleAlertLeaseCutoff}
      )`,
    ));
  }
  await Promise.all(candidates.map(async (mission) => {
    const legs = mission.bundleId ? legsByBundle.get(mission.bundleId) ?? [mission] : [mission];
    const bundle = mission.bundleId ? bundleById.get(mission.bundleId) ?? null : null;
    const target = missionAlertTarget(mission, scoutUserId);
    const copy = missionAlertCopy(mission, legs, bundle, target.preferredCopy);
    await adoptLegacyMissionAlertKeys(scoutUserId, mission.id, target.scope, target.generation);
    await notifyUserOnce({
      recipientUserId: scoutUserId,
      missionId: mission.id,
      kind: "new_mission",
      dedupeScope: target.scope,
      ...copy,
    }, {
      stillEligible: () => scoutStillEligibleForMissionAlert(
        scoutUserId,
        mission.id,
        target.scope,
      ),
    });
  }));
  return candidates.length;
}

export async function reconcileOpenMissionAlerts() {
  const openRoots = await getDb().select({ id: missions.id }).from(missions).where(and(
    eq(missions.status, "open"),
    eq(missions.paymentStatus, "paid"),
    isNull(missions.archivedAt),
    sql`(${missions.bundleId} IS NULL OR ${missions.bundleSequence} = 1)`,
  )).orderBy(asc(missions.createdAt));
  let processed = 0;
  let errors = 0;
  for (const mission of openRoots) {
    try {
      await alertEligibleScouts(mission.id);
      processed += 1;
    } catch (error) {
      errors += 1;
      console.error("Open mission alert reconciliation failed", {
        missionId: mission.id,
        error: error instanceof Error ? error.message : "Unknown alert reconciliation error",
      });
    }
  }
  return { found: openRoots.length, processed, errors };
}
