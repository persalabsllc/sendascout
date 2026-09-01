import type { ScoutOnboardingProgress } from "./scout-onboarding-progress.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const SCOUT_ONBOARDING_REMINDER_STAGES = [
  { key: "six_hours", minimumAgeMs: 6 * HOUR_MS, title: "Finish your Scout setup" },
  { key: "two_days", minimumAgeMs: 2 * DAY_MS, title: "Your Scout setup is waiting" },
  { key: "seven_days", minimumAgeMs: 7 * DAY_MS, title: "You’re close to claiming Scout missions" },
  { key: "fourteen_days", minimumAgeMs: 14 * DAY_MS, title: "Need help finishing your Scout setup?" },
  { key: "twenty_eight_days", minimumAgeMs: 28 * DAY_MS, title: "Your Scout application is still open" },
] as const;

export type ScoutOnboardingReminderStage = typeof SCOUT_ONBOARDING_REMINDER_STAGES[number];

export function isScoutOnboardingNotificationKind(kind: string) {
  return kind === "scout_onboarding_welcome" || kind.startsWith("scout_onboarding_reminder_");
}

export function scoutOnboardingReminderStage(createdAt: Date, now = new Date()) {
  const ageMs = Math.max(0, now.getTime() - createdAt.getTime());
  return SCOUT_ONBOARDING_REMINDER_STAGES.findLast((stage) => ageMs >= stage.minimumAgeMs) ?? null;
}

export function scoutOnboardingReminderBody(progress: ScoutOnboardingProgress) {
  const completed = progress.steps.filter((step) => step.complete).map((step) => `✓ ${step.label}`);
  const missing = progress.steps.filter((step) => !step.complete).map((step) => `○ ${step.label}`);
  return [
    `Your Scout setup is ${progress.completedCount} of ${progress.totalCount} steps complete.`,
    "",
    "COMPLETED",
    ...completed,
    "",
    "STILL NEEDED",
    ...missing,
    "",
    "You can browse any matching missions in your dashboard as they become available. Complete the remaining steps to unlock claiming.",
  ].join("\n");
}
