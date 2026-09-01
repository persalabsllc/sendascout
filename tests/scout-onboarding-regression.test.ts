import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const onboardingForm = readFileSync(new URL("../components/onboarding-form.tsx", import.meta.url), "utf8");
const scoutEntry = readFileSync(new URL("../app/scout/page.tsx", import.meta.url), "utf8");
const missionActions = readFileSync(new URL("../app/actions/missions.ts", import.meta.url), "utf8");
const notifications = readFileSync(new URL("../lib/notifications.ts", import.meta.url), "utf8");

test("Scout onboarding requires and securely saves a headshot before completion", () => {
  assert.match(onboardingForm, /Profile headshot/);
  assert.match(onboardingForm, /required=\{!headshot\}/);
  assert.match(onboardingForm, /createScoutApplication\(scout\)/);
  assert.match(onboardingForm, /upload\(`scout-headshots\/\$\{result\.scoutUserId\}/);
  assert.match(onboardingForm, /saveScoutHeadshot\(blob\.pathname\)/);
  assert.ok(onboardingForm.indexOf("createScoutApplication(scout)") < onboardingForm.indexOf("saveScoutHeadshot(blob.pathname)"));
});

test("an interrupted post-application photo upload has a recovery route", () => {
  assert.match(scoutEntry, /profile\?\.headshotPath/);
  assert.match(scoutEntry, /redirect\("\/dashboard\/scout\/settings"\)/);
});

test("approval backfills deduplicated alerts for currently open eligible missions", () => {
  assert.match(missionActions, /alertScoutToOpenMissions\(profile\.userId\)/);
  assert.match(notifications, /eq\(missions\.status, "open"\)/);
  assert.match(notifications, /const target = missionAlertTarget\(mission, scoutUserId\)/);
  assert.match(notifications, /dedupeScope: target\.scope/);
  assert.match(notifications, /onConflictDoNothing\(\{ target: notifications\.dedupeKey \}\)/);
  assert.match(notifications, /isMissionEligibleForScout\(leg, scout\)/);
});
