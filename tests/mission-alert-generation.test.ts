import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const schema = readFileSync(new URL("../db/schema.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../db/migrations/0018_notification_dedupe.sql", import.meta.url), "utf8");
const payments = readFileSync(new URL("../lib/stripe-payments.ts", import.meta.url), "utf8");
const missions = readFileSync(new URL("../app/actions/missions.ts", import.meta.url), "utf8");
const hourly = readFileSync(new URL("../app/api/cron/auto-complete/route.ts", import.meta.url), "utf8");

test("missions store a durable nonnegative alert publication generation", () => {
  assert.match(schema, /alertGeneration: integer\("alert_generation"\)\.notNull\(\)\.default\(0\)/);
  assert.match(schema, /missions_alert_generation_check[\s\S]*table\.alertGeneration} >= 0/);
  assert.match(migration, /ALTER TABLE "missions" ADD COLUMN "alert_generation" integer DEFAULT 0 NOT NULL/);
  assert.match(migration, /missions_alert_generation_check[\s\S]*"alert_generation" >= 0/);
});

test("successful booking payment atomically advances the initial publication generation", () => {
  const publication = payments.slice(
    payments.indexOf("published_root AS"),
    payments.indexOf("marked_children AS"),
  );
  assert.match(publication, /SET status = 'open'/);
  assert.match(publication, /alert_generation = root\.alert_generation \+ 1/);
  assert.match(payments, /if \(published\) await alertEligibleScouts\(row\.mission\.id\)/);
});

test("Control Room reopen advances the generation in both single and bundled paths", () => {
  const controlRoomTransition = missions.slice(
    missions.indexOf("export async function adminSetMissionStatus"),
    missions.indexOf("export async function markNotificationRead"),
  );
  assert.match(controlRoomTransition, /WHEN \$\{status\} = 'open' THEN root\.alert_generation \+ 1/);
  assert.match(controlRoomTransition, /status === "open" \? \{ alertGeneration: sql`\$\{missions\.alertGeneration\} \+ 1` \} : \{\}/);
  assert.match(controlRoomTransition, /if \(status === "open"\) await alertEligibleScouts\(rootMission\.id\)/);
});

test("preferred-window release creates a public generation and hourly replay is durable", () => {
  assert.match(hourly, /SET preferred_scout_broadcast_at = \$\{now\},[\s\S]*alert_generation = mission\.alert_generation \+ 1/);
  assert.match(hourly, /await alertEligibleScouts\(released\.id\)/);
  assert.match(hourly, /const openMissionAlertReconciliation = await reconcileOpenMissionAlerts\(\)/);
  assert.match(hourly, /preferredBroadcasts, openMissionAlertReconciliation, recurringReminders/);
});
