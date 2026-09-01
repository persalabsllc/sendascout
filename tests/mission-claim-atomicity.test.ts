import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const missionActions = readFileSync(new URL("../app/actions/missions.ts", import.meta.url), "utf8");
const notifications = readFileSync(new URL("../lib/notifications.ts", import.meta.url), "utf8");
const hourly = readFileSync(new URL("../app/api/cron/auto-complete/route.ts", import.meta.url), "utf8");
const claimStart = missionActions.indexOf("export async function claimMission");
const claimEnd = missionActions.indexOf("export async function updateMissionStatus", claimStart);
const claimSource = missionActions.slice(claimStart, claimEnd);

test("atomic claim paths lock and revalidate the active Scout user before the profile", () => {
  assert.notEqual(claimStart, -1);
  assert.notEqual(claimEnd, -1);
  assert.equal((claimSource.match(/WITH locked_user AS MATERIALIZED \(/g) ?? []).length, 2);
  assert.equal((claimSource.match(/FROM users AS claim_user[\s\S]*?FOR UPDATE[\s\S]*?\), locked_profile AS MATERIALIZED/g) ?? []).length, 2);

  for (const predicate of [
    "claim_user.role = 'scout'",
    "claim_user.status = 'active'",
    "claim_user.legal_version = ${LEGAL_VERSION}",
    "claim_user.legal_accepted_at IS NOT NULL",
    "btrim(COALESCE(claim_user.first_name, '')) <> ''",
    "btrim(COALESCE(claim_user.last_name, '')) <> ''",
    "length(regexp_replace(COALESCE(claim_user.phone, ''), '\\\\D', '', 'g')) >= 10",
    "AND EXISTS (SELECT 1 FROM locked_user WHERE locked_user.id = approved_profile.user_id)",
    "AND btrim(approved_profile.identity_verified_name) <> ''",
    "AND approved_profile.stripe_sync_completed_generation = approved_profile.stripe_sync_generation",
  ]) {
    assert.equal(claimSource.split(predicate).length - 1, 2, `${predicate} must exist in both atomic paths`);
  }
});

test("claim audit rows commit in the same SQL statement as the authoritative claim", () => {
  assert.equal((claimSource.match(/\), audited AS \(\s*INSERT INTO mission_updates/g) ?? []).length, 2);
  assert.match(claimSource, /FROM assigned\s+WHERE EXISTS \(SELECT 1 FROM claimed_bundle\)\s+RETURNING mission_id/);
  assert.match(claimSource, /FROM claimed_mission\s+RETURNING mission_id/);
  assert.match(claimSource, /COUNT\(\*\) FROM audited\) = \(SELECT COUNT\(\*\) FROM assigned/);
  assert.doesNotMatch(claimSource, /await db\.insert\(missionUpdates\)/);
});

test("the authoritative claim also commits an idempotent customer-notification checkpoint", () => {
  assert.match(claimSource, /const claimNotification = missionClaimedNotificationInput\(/);
  assert.match(claimSource, /notificationChannelDedupeKey\(claimNotification, "in_app"\)/);
  assert.equal((claimSource.match(/\), notification_checkpoint AS \(\s*INSERT INTO notifications/g) ?? []).length, 2);
  assert.equal((claimSource.match(/'in_app'::notification_channel, 'sent'::notification_status/g) ?? []).length, 2);
  assert.equal((claimSource.match(/ON CONFLICT \(dedupe_key\) DO NOTHING/g) ?? []).length, 2);
  assert.equal((claimSource.match(/SELECT 1 FROM notification_checkpoint/g) ?? []).length, 2);
  assert.equal((claimSource.match(/SELECT 1 FROM notifications AS existing_checkpoint/g) ?? []).length, 2);
});

test("post-commit customer notification and cache refresh cannot turn a claim into a false failure", () => {
  const committedAt = claimSource.indexOf("if (!claimedResult.rows[0]?.id)");
  const notificationAt = claimSource.indexOf("await notifyUserOnce", committedAt);
  const successAt = claimSource.indexOf("return { ok: true }", notificationAt);

  assert.ok(committedAt >= 0 && notificationAt > committedAt && successAt > notificationAt);
  assert.match(claimSource.slice(committedAt, successAt), /try \{[\s\S]*await notifyUserOnce\(claimNotification\);[\s\S]*\} catch \(error\) \{[\s\S]*missions\.claim_notification/);
  assert.match(claimSource.slice(notificationAt, successAt), /try \{\s*refreshMission\(id\);[\s\S]*missions\.claim_revalidation/);
  assert.equal((claimSource.match(/await getMission\(id\)/g) ?? []).length, 1, "claim must not reload after commit");
});

test("hourly recovery safely resumes provider deliveries from the atomic checkpoint", () => {
  const recoveryStart = notifications.indexOf("export async function reconcileClaimedMissionNotifications");
  const recoveryEnd = notifications.indexOf("export async function alertEligibleScouts", recoveryStart);
  const recovery = notifications.slice(recoveryStart, recoveryEnd);

  assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart);
  assert.match(recovery, /claim_audit\.author_id = claimed\.scout_id[\s\S]*claim_audit\.status = 'claimed'/);
  assert.match(recovery, /checkpoint\.channel = 'in_app'[\s\S]*checkpoint\.status = 'sent'[\s\S]*checkpoint\.kind = 'mission_claimed'[\s\S]*checkpoint\.dedupe_key IS NOT NULL/);
  assert.match(recovery, /pending_email\.status = 'pending'[\s\S]*pending_email\.provider_message_id IS NULL/);
  assert.match(recovery, /pending_sms\.status = 'pending'[\s\S]*pending_sms\.provider_message_id IS NULL/);
  assert.match(recovery, /notifyUserOnce\(missionClaimedNotificationInput\(\{/);
  assert.match(notifications, /CLAIM_NOTIFICATION_RECOVERY_WINDOW_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(recovery, /claimed\.claimed_at >= \$\{recoveryCutoff\}/);
  assert.match(recovery, /claimed\.archived_at IS NULL/);
  assert.match(recovery, /claimed\.status IN \([\s\S]*'claimed'[\s\S]*'at_dropoff'[\s\S]*\)/);
  assert.match(recovery, /stillEligible: \(\) => claimedMissionNotificationStillEligible\(candidate, recoveryCutoff\)/);
  assert.match(recovery, /stale_notice\.status = 'pending'[\s\S]*stale_notice\.provider_message_id IS NULL/);
  assert.match(recovery, /stale_notice\.last_attempt_at <= \$\{leaseCutoff\}/);
  assert.match(recovery, /return \{ found: result\.rows\.length, recovered, retired: retiredResult\.rows\.length, errors \}/);
  assert.match(notifications, /notificationChannelDedupeKey[\s\S]*notificationEventKey\(input\)/);
  assert.match(hourly, /runHourlyStage\([\s\S]*"claimed_mission_notifications"[\s\S]*reconcileClaimedMissionNotifications\(\)/);
});
