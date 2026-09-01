import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const missionActions = readFileSync(new URL("../app/actions/missions.ts", import.meta.url), "utf8");
const notifications = readFileSync(new URL("../lib/notifications.ts", import.meta.url), "utf8");
const controlRoomPage = readFileSync(new URL("../app/control-room/page.tsx", import.meta.url), "utf8");
const controlRoom = readFileSync(new URL("../components/control-room.tsx", import.meta.url), "utf8");

function section(value: string, start: string, end?: string) {
  const startIndex = value.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  const endIndex = end ? value.indexOf(end, startIndex + start.length) : -1;
  return value.slice(startIndex, endIndex === -1 ? undefined : endIndex);
}

test("result submission notifies both the customer and the Scout with accurate lifecycle copy", () => {
  assert.match(missionActions, /kind: "results_submitted"/);
  assert.match(missionActions, /recipientUserId: user\.id,[\s\S]*kind: "results_submission_received"/);
  assert.match(missionActions, /Results submitted — awaiting review/);
  assert.match(missionActions, /awaiting customer review\. The mission is not complete, and payout has not been released\./);
  assert.match(missionActions, /Mission part submitted[\s\S]*Continue with the next part\. The full mission is not complete, and payout has not been released\./);
  assert.match(missionActions, /Promise\.all\(\[[\s\S]*notifyUser\(resultNotification\),[\s\S]*notifyUser\(scoutSubmissionNotification\)/);
});

test("email provider acceptance remains pending and uses a deterministic key per attempt", () => {
  assert.match(notifications, /"Idempotency-Key": `sendascout-email-\$\{notificationId\}-attempt-\$\{attempt\}`/);
  assert.doesNotMatch(notifications, /crypto\.randomUUID/);
  assert.match(notifications, /set\(\{ providerMessageId, sentAt: null, error: null \}\)/);
  assert.match(notifications, /where\(activeProviderAttemptLease\(/);
  assert.match(notifications, /console\.info\("Send a Scout email accepted by provider", \{[\s\S]*notificationId:[\s\S]*kind:[\s\S]*attempt:[\s\S]*providerMessageId/);
  assert.doesNotMatch(notifications, /item\.status === "sent"\) throw new Error\("This email was already delivered\."\)/);
  assert.match(notifications, /response\.status === 408[\s\S]*response\.status === 429[\s\S]*response\.status >= 500/);
  assert.match(notifications, /ambiguous response without a message ID/);
  assert.match(notifications, /error instanceof EmailProviderRejectedError \? "failed" : "pending"/);
});

test("Control Room distinguishes email acceptance and permits an intentional resend", () => {
  assert.match(controlRoomPage, /providerAccepted: Boolean\(notification\.providerMessageId\)/);
  assert.match(controlRoom, /Accepted by email provider[\s\S]*delivery is not independently confirmed/);
  assert.match(controlRoom, /item\.channel === "email" && item\.providerAccepted \? "Resend" : "Retry"/);
});

test("SMS keeps its provider-callback delivery behavior", () => {
  assert.match(notifications, /sendSentSms\(\{ notificationId: queued\.id/);
  assert.match(notifications, /set\(\{ providerMessageId, error: null \}\)/);
  assert.match(notifications, /if \(item\.status === "sent"\) throw new Error\("This text was already delivered\."\)/);
});

test("stale payload recovery cannot overwrite a concurrent provider result", () => {
  const once = section(notifications, "export async function notifyUserOnce", "async function expireUnsafeAmbiguousReplay");
  const emailPayloadChange = section(once, "if (email && email.attemptCount > 0", "if (sms && sms.attemptCount > 0");
  const smsPayloadChange = section(once, "if (sms && sms.attemptCount > 0", "const [emailQueued, smsQueued]");

  for (const branch of [emailPayloadChange, smsPayloadChange]) {
    assert.match(branch, /eq\(notifications\.status, "pending"\)/);
    assert.match(branch, /isNull\(notifications\.providerMessageId\)/);
    assert.match(branch, /eq\(notifications\.attemptCount,/);
    assert.match(branch, /providerAttemptStartedAt\} IS NOT DISTINCT FROM/);
    assert.match(branch, /lastAttemptAt\} IS NOT DISTINCT FROM/);
  }
});

test("eligibility cleanup cannot delete a concurrently claimed external delivery", () => {
  const once = section(notifications, "export async function notifyUserOnce", "async function expireUnsafeAmbiguousReplay");
  const cleanup = section(once, "if (options.stillEligible && !await options.stillEligible())", "const payloadChanged");
  assert.match(cleanup, /row\.channel === "email" \|\| row\.channel === "sms"/);
  assert.match(cleanup, /eq\(notifications\.status, "pending"\)/);
  assert.match(cleanup, /isNull\(notifications\.providerMessageId\)/);
  assert.match(cleanup, /eq\(notifications\.attemptCount, 0\)/);
  assert.match(cleanup, /releasedExternal\.length === insertedExternalIds\.length/);
  assert.match(cleanup, /!referencesUnownedExternal/);
  assert.doesNotMatch(cleanup, /inserted\.map\(\(row\) => row\.id\)/);
});

test("ambiguous outcome expiry cannot invalidate an active provider lease", () => {
  const automaticExpiry = section(notifications, "async function expireUnsafeAmbiguousReplay", "function activeProviderAttemptLease");
  assert.match(automaticExpiry, /const leaseCutoff = new Date/);
  assert.match(automaticExpiry, /lastAttemptAt\} IS NULL/);
  assert.match(automaticExpiry, /lastAttemptAt\} <= \$\{leaseCutoff\}/);

  const emailRetry = section(notifications, "export async function retryEmailNotification", "export async function retrySmsNotification");
  const smsRetry = section(notifications, "export async function retrySmsNotification", "export async function retryNotification");
  for (const retry of [emailRetry, smsRetry]) {
    const expiry = section(retry, "if (ambiguousAttempt && (!item.providerAttemptStartedAt", "throw new Error(OUTCOME_UNKNOWN_RECONCILIATION_ERROR);");
    assert.match(expiry, /lastAttemptAt\} IS NOT DISTINCT FROM \$\{item\.lastAttemptAt\}/);
  }
});

test("email recovery resolves the current address under the active provider lease", () => {
  const recipientLookup = section(notifications, "async function currentEmailRecipientForLease", "async function deliverClaimedEmailOnce");
  assert.match(recipientLookup, /email: users\.email/);
  assert.match(recipientLookup, /activeProviderAttemptLease\(notificationId, attempt, leaseAt\)/);

  const oneTimeDelivery = section(notifications, "async function deliverClaimedEmailOnce", "async function deliverClaimedSmsOnce");
  assert.ok(oneTimeDelivery.indexOf("currentEmailRecipientForLease") < oneTimeDelivery.indexOf("await sendEmail"));
  assert.match(oneTimeDelivery, /await sendEmail\(\s*currentRecipient\.email,/);

  const manualRetry = section(notifications, "export async function retryEmailNotification", "export async function retrySmsNotification");
  assert.ok(manualRetry.indexOf("currentEmailRecipientForLease") < manualRetry.indexOf("await sendEmail"));
  assert.match(manualRetry, /await sendEmail\(\s*currentRecipient\.email,/);
  assert.doesNotMatch(manualRetry, /item\.email/);
});

test("manual SMS recovery resolves current contact and consent under the active lease", () => {
  const recipientLookup = section(notifications, "async function currentSmsRecipientForLease", "async function deliverClaimedEmailOnce");
  assert.match(recipientLookup, /phone: users\.phone/);
  assert.match(recipientLookup, /smsNotificationsEnabled: users\.smsNotificationsEnabled/);
  assert.match(recipientLookup, /smsConsentedAt: users\.smsConsentedAt/);
  assert.match(recipientLookup, /activeProviderAttemptLease\(notificationId, attempt, leaseAt\)/);

  const manualRetry = section(notifications, "export async function retrySmsNotification", "export async function retryNotification");
  assert.ok(manualRetry.indexOf("currentSmsRecipientForLease") < manualRetry.indexOf("await sendSentSms"));
  assert.match(manualRetry, /to: currentRecipient\.phone/);
  assert.doesNotMatch(manualRetry, /to: item\.phone/);
  assert.match(manualRetry, /sameEmailPayload\(sendPayload, finalPayload\)/);
});

test("immediate provider sends refresh contact and preferences under their lease", () => {
  const emailQueue = section(notifications, "async function queueEmail", "async function queueSms");
  assert.ok(emailQueue.indexOf("currentEmailRecipientForLease") < emailQueue.indexOf("await sendEmail"));
  assert.match(emailQueue, /await sendEmail\(currentRecipient\.email/);
  assert.match(emailQueue, /currentRecipient\.status !== "active" \|\| !currentRecipient\.emailNotificationsEnabled/);
  assert.doesNotMatch(emailQueue, /input\.email/);

  const smsQueue = section(notifications, "async function queueSms", "type EmailRetryItem");
  assert.ok(smsQueue.indexOf("currentSmsRecipientForLease") < smsQueue.indexOf("await sendSentSms"));
  assert.match(smsQueue, /to: currentRecipient\.phone/);
  assert.match(smsQueue, /!currentRecipient\.smsNotificationsEnabled/);
  assert.match(smsQueue, /!currentRecipient\.smsConsentedAt/);
  assert.doesNotMatch(smsQueue, /input\.phone/);
});
