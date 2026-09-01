import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const notifications = readFileSync(new URL("../lib/notifications.ts", import.meta.url), "utf8");
const cron = readFileSync(new URL("../app/api/cron/auto-complete/route.ts", import.meta.url), "utf8");

function section(value: string, start: string, end?: string) {
  const startIndex = value.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  const endIndex = end ? value.indexOf(end, startIndex + start.length) : -1;
  return value.slice(startIndex, endIndex === -1 ? undefined : endIndex);
}

test("mission alert dedupe follows the mission's durable alert generation", () => {
  const scope = section(notifications, "function missionAlertScope", "async function adoptLegacyMissionAlertKeys");
  assert.match(scope, /mission\.id/);
  assert.match(scope, /mission\.alertGeneration/);
  assert.doesNotMatch(notifications, /missionPublicationScopes|MISSION_PUBLICATION_EVIDENCE_KIND|missionUpdates/);

  const finalEligibility = section(notifications, "async function scoutStillEligibleForMissionAlert", "function escapeHtml");
  assert.match(finalEligibility, /missionAlertTarget\(mission, scoutUserId\)\.scope !== expectedScope/);
});

test("generation-zero legacy alerts are adopted without replaying their pending delivery", () => {
  const compatibility = section(notifications, "async function adoptLegacyMissionAlertKeys", "async function scoutStillEligibleForMissionAlert");
  assert.match(compatibility, /if \(generation !== 0\) return/);
  assert.match(compatibility, /legacy\.recipient_user_id = \$\{scoutUserId\}/);
  assert.match(compatibility, /legacy\.mission_id = \$\{missionId\}/);
  assert.match(compatibility, /legacy\.kind = 'new_mission'/);
  assert.match(compatibility, /legacy\.dedupe_key IS NULL/);
  assert.match(compatibility, /SET dedupe_key = \$\{targetKey\}/);
  assert.match(compatibility, /NOT EXISTS \([\s\S]*existing\.dedupe_key = \$\{targetKey\}/);
  assert.match(compatibility, /Superseded by the canonical legacy mission alert delivery/);
  assert.match(compatibility, /eq\(notifications\.status, "pending"\)/);
  assert.match(compatibility, /isNull\(notifications\.providerMessageId\)/);
  assert.match(compatibility, /notifications\.attemptCount\} = 0[\s\S]*notifications\.lastAttemptAt\} <= \$\{leaseCutoff\}/);

  const manualRetry = section(notifications, "async function currentEmailRetryPayload", "export async function retryEmailNotification");
  assert.match(manualRetry, /await adoptLegacyMissionAlertKeys/);
  assert.match(manualRetry, /canonicalLegacyDelivery\?\.id === item\.id/);

  const publicationAlerts = section(notifications, "export async function alertEligibleScouts", "export async function alertScoutToOpenMissions");
  const scoutBackfill = section(notifications, "export async function alertScoutToOpenMissions", "export async function reconcileOpenMissionAlerts");
  for (const alertPath of [publicationAlerts, scoutBackfill]) {
    assert.match(alertPath, /await adoptLegacyMissionAlertKeys/);
    assert.ok(alertPath.indexOf("await adoptLegacyMissionAlertKeys") < alertPath.indexOf("await notifyUserOnce"));
  }
  assert.match(scoutBackfill, /\.filter\(\(alert\) => alert\.dedupeKey && !validDeliveryKeys\.has\(alert\.dedupeKey\)\)/);
  assert.match(scoutBackfill, /const staleAlertLeaseCutoff = new Date/);
  assert.match(scoutBackfill, /inArray\(notifications\.id, staleAlertIds\)[\s\S]*eq\(notifications\.status, "pending"\)[\s\S]*isNull\(notifications\.providerMessageId\)/);
  assert.match(scoutBackfill, /notifications\.attemptCount\} = 0[\s\S]*notifications\.lastAttemptAt\} <= \$\{staleAlertLeaseCutoff\}/);
});

test("preferred alerts stay exclusive until the durable broadcast transition", () => {
  const preference = section(notifications, "function preferredAlertIsExclusive", "function missionAlertCopy");
  assert.match(preference, /mission\.preferredScoutId && !mission\.preferredScoutBroadcastAt/);
  assert.doesNotMatch(preference, /preferredScoutExclusiveUntil|Date\.now/);

  const publicationAlerts = section(notifications, "export async function alertEligibleScouts", "export async function alertScoutToOpenMissions");
  const scoutBackfill = section(notifications, "export async function alertScoutToOpenMissions", "export async function reconcileOpenMissionAlerts");
  for (const alertPath of [publicationAlerts, scoutBackfill]) {
    assert.match(alertPath, /preferredAlertIsExclusive\(mission\)/);
    assert.match(alertPath, /mission\.preferredScoutId/);
  }
});

test("hourly reconciliation replays every currently paid open root mission", () => {
  const reconciliation = section(notifications, "export async function reconcileOpenMissionAlerts");
  assert.match(reconciliation, /eq\(missions\.status, "open"\)/);
  assert.match(reconciliation, /eq\(missions\.paymentStatus, "paid"\)/);
  assert.match(reconciliation, /isNull\(missions\.archivedAt\)/);
  assert.match(reconciliation, /missions\.bundleId\} IS NULL OR \$\{missions\.bundleSequence\} = 1/);
  assert.match(reconciliation, /for \(const mission of openRoots\)/);
  assert.match(reconciliation, /await alertEligibleScouts\(mission\.id\)/);
  assert.match(reconciliation, /return \{ found: openRoots\.length, processed, errors \}/);
  assert.match(cron, /await reconcileOpenMissionAlerts\(\)/);
});
