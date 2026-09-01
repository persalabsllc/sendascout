import "server-only";

import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { notifications, scoutProfiles, users } from "@/db/schema";
import { getAppUrl } from "@/lib/app-url";
import { notifyUserOnce } from "@/lib/notifications";
import { tryAutoApproveScout } from "@/lib/scout-auto-approval";
import {
  SCOUT_ONBOARDING_REMINDER_STAGES,
  scoutOnboardingReminderBody,
  scoutOnboardingReminderStage,
} from "@/lib/scout-onboarding-reminder-policy";
import {
  loadActiveScoutOnboarding,
  onboardingProgressFor,
  scoutOnboardingProgressFingerprint,
  scoutStillNeedsOnboardingReminder,
} from "@/lib/scout-onboarding-status";

const WELCOME_REMINDER_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export async function sendScoutOnboardingWelcome(userId: string) {
  await tryAutoApproveScout(userId);
  const current = await loadActiveScoutOnboarding(userId);
  if (!current) return { created: false, emailQueued: false };
  const progress = onboardingProgressFor(current);
  if (progress.ready || !progress.nextStep) return { created: false, emailQueued: false };
  const progressFingerprint = scoutOnboardingProgressFingerprint(progress);

  return notifyUserOnce({
    recipientUserId: current.user.id,
    kind: "scout_onboarding_welcome",
    title: "Welcome to Send a Scout",
    body: scoutOnboardingReminderBody(progress),
    actionLabel: progress.nextStep.actionLabel,
    actionUrl: new URL(progress.nextStep.href, `${getAppUrl()}/`).toString(),
    sendEmail: true,
    sendSms: false,
  }, {
    stillEligible: () => scoutStillNeedsOnboardingReminder(current.user.id, progressFingerprint),
  });
}

/** Hourly fallback for a request that stopped after saving the Scout profile. */
export async function runScoutOnboardingWelcomes(limit = 100) {
  const db = getDb();
  const candidates = await db.select({ userId: users.id })
    .from(scoutProfiles)
    .innerJoin(users, eq(users.id, scoutProfiles.userId))
    .where(and(
      eq(users.role, "scout"),
      eq(users.status, "active"),
      inArray(scoutProfiles.status, ["applicant", "review"]),
      sql`(
        NOT EXISTS (
          SELECT 1 FROM ${notifications} AS welcome_in_app
          WHERE welcome_in_app.recipient_user_id = ${users.id}
            AND welcome_in_app.mission_id IS NULL
            AND welcome_in_app.channel = 'in_app'
            AND welcome_in_app.kind = 'scout_onboarding_welcome'
        )
        OR (
          ${users.emailNotificationsEnabled} = TRUE
          AND (
            NOT EXISTS (
              SELECT 1 FROM ${notifications} AS welcome_email
              WHERE welcome_email.recipient_user_id = ${users.id}
                AND welcome_email.mission_id IS NULL
                AND welcome_email.channel = 'email'
                AND welcome_email.kind = 'scout_onboarding_welcome'
            )
            OR EXISTS (
              SELECT 1 FROM ${notifications} AS recoverable_welcome_email
              WHERE recoverable_welcome_email.recipient_user_id = ${users.id}
                AND recoverable_welcome_email.mission_id IS NULL
                AND recoverable_welcome_email.channel = 'email'
                AND recoverable_welcome_email.kind = 'scout_onboarding_welcome'
                AND recoverable_welcome_email.status = 'pending'
                AND recoverable_welcome_email.provider_message_id IS NULL
            )
          )
        )
      )`,
    ))
    .orderBy(asc(scoutProfiles.createdAt))
    .limit(Math.max(1, Math.min(250, limit)));

  let sent = 0;
  let emailed = 0;
  let errors = 0;
  for (const candidate of candidates) {
    try {
      const result = await sendScoutOnboardingWelcome(candidate.userId);
      if (result.created) sent += 1;
      if (result.emailQueued) emailed += 1;
    } catch (error) {
      errors += 1;
      console.error("Scout onboarding welcome recovery failed", {
        userId: candidate.userId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
  return { found: candidates.length, sent, emailed, errors };
}

export async function runScoutOnboardingReminders(now = new Date(), limit = 100) {
  const db = getDb();
  const firstReminderCutoff = new Date(now.getTime() - SCOUT_ONBOARDING_REMINDER_STAGES[0].minimumAgeMs);
  const welcomeCooldownCutoff = new Date(now.getTime() - WELCOME_REMINDER_COOLDOWN_MS);
  const latestEligibleReminderKind = sql`CASE
    WHEN ${scoutProfiles.createdAt} <= ${new Date(now.getTime() - SCOUT_ONBOARDING_REMINDER_STAGES[4].minimumAgeMs)}
      THEN ${`scout_onboarding_reminder_${SCOUT_ONBOARDING_REMINDER_STAGES[4].key}`}
    WHEN ${scoutProfiles.createdAt} <= ${new Date(now.getTime() - SCOUT_ONBOARDING_REMINDER_STAGES[3].minimumAgeMs)}
      THEN ${`scout_onboarding_reminder_${SCOUT_ONBOARDING_REMINDER_STAGES[3].key}`}
    WHEN ${scoutProfiles.createdAt} <= ${new Date(now.getTime() - SCOUT_ONBOARDING_REMINDER_STAGES[2].minimumAgeMs)}
      THEN ${`scout_onboarding_reminder_${SCOUT_ONBOARDING_REMINDER_STAGES[2].key}`}
    WHEN ${scoutProfiles.createdAt} <= ${new Date(now.getTime() - SCOUT_ONBOARDING_REMINDER_STAGES[1].minimumAgeMs)}
      THEN ${`scout_onboarding_reminder_${SCOUT_ONBOARDING_REMINDER_STAGES[1].key}`}
    ELSE ${`scout_onboarding_reminder_${SCOUT_ONBOARDING_REMINDER_STAGES[0].key}`}
  END`;
  const candidates = await db.select({
    userId: users.id,
    createdAt: scoutProfiles.createdAt,
  }).from(scoutProfiles).innerJoin(users, eq(users.id, scoutProfiles.userId)).where(and(
    eq(users.role, "scout"),
    eq(users.status, "active"),
    inArray(scoutProfiles.status, ["applicant", "review"]),
    lte(scoutProfiles.createdAt, firstReminderCutoff),
    sql`EXISTS (
      SELECT 1 FROM ${notifications} AS prior_welcome
      WHERE prior_welcome.recipient_user_id = ${users.id}
        AND prior_welcome.mission_id IS NULL
        AND prior_welcome.channel = 'in_app'
        AND prior_welcome.kind = 'scout_onboarding_welcome'
        AND prior_welcome.created_at <= ${welcomeCooldownCutoff}
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM ${notifications} AS recent_welcome_email
      WHERE recent_welcome_email.recipient_user_id = ${users.id}
        AND recent_welcome_email.mission_id IS NULL
        AND recent_welcome_email.channel = 'email'
        AND recent_welcome_email.kind = 'scout_onboarding_welcome'
        AND COALESCE(recent_welcome_email.last_attempt_at, recent_welcome_email.created_at) > ${welcomeCooldownCutoff}
    )`,
    sql`(
      NOT EXISTS (
        SELECT 1 FROM ${notifications} AS onboarding_milestone
        WHERE onboarding_milestone.recipient_user_id = ${users.id}
          AND onboarding_milestone.mission_id IS NULL
          AND onboarding_milestone.channel = 'in_app'
          AND onboarding_milestone.kind = ${latestEligibleReminderKind}
      )
      OR (
        ${users.emailNotificationsEnabled} = TRUE
        AND (
          NOT EXISTS (
            SELECT 1 FROM ${notifications} AS onboarding_email
            WHERE onboarding_email.recipient_user_id = ${users.id}
              AND onboarding_email.mission_id IS NULL
              AND onboarding_email.channel = 'email'
              AND onboarding_email.kind = ${latestEligibleReminderKind}
          )
          OR EXISTS (
            SELECT 1 FROM ${notifications} AS recoverable_onboarding_email
            WHERE recoverable_onboarding_email.recipient_user_id = ${users.id}
              AND recoverable_onboarding_email.mission_id IS NULL
              AND recoverable_onboarding_email.channel = 'email'
              AND recoverable_onboarding_email.kind = ${latestEligibleReminderKind}
              AND recoverable_onboarding_email.status = 'pending'
              AND recoverable_onboarding_email.provider_message_id IS NULL
          )
        )
      )
    )`,
  )).orderBy(asc(scoutProfiles.createdAt)).limit(Math.max(1, Math.min(250, limit)));

  let sent = 0;
  let emailed = 0;
  let skipped = 0;
  let errors = 0;
  for (const candidate of candidates) {
    try {
      const stage = scoutOnboardingReminderStage(candidate.createdAt, now);
      if (!stage) {
        skipped += 1;
        continue;
      }

      // Recover a just-completed Scout first, then re-read immediately before
      // claiming the notification. This stops a
      // stale hourly query from emailing a Scout who was approved, paused,
      // rejected, suspended, or completed setup while this job was running.
      await tryAutoApproveScout(candidate.userId);
      const current = await loadActiveScoutOnboarding(candidate.userId);
      if (!current) {
        skipped += 1;
        continue;
      }

      const progress = onboardingProgressFor(current);
      if (progress.ready || !progress.nextStep) {
        skipped += 1;
        continue;
      }

      const kind = `scout_onboarding_reminder_${stage.key}`;
      const actionUrl = new URL(progress.nextStep.href, `${getAppUrl()}/`).toString();
      const progressFingerprint = scoutOnboardingProgressFingerprint(progress);
      const result = await notifyUserOnce({
        recipientUserId: current.user.id,
        kind,
        title: stage.title,
        body: scoutOnboardingReminderBody(progress),
        actionLabel: progress.nextStep.actionLabel,
        actionUrl,
        sendEmail: true,
        sendSms: false,
      }, {
        stillEligible: () => scoutStillNeedsOnboardingReminder(current.user.id, progressFingerprint),
      });
      if (result.created) sent += 1;
      else skipped += 1;
      if (result.emailQueued) emailed += 1;
    } catch (error) {
      errors += 1;
      console.error("Scout onboarding reminder failed", {
        userId: candidate.userId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
  return { found: candidates.length, sent, emailed, skipped, errors };
}
