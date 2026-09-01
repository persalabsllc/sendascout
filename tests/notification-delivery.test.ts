import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const missionActions = readFileSync(new URL("../app/actions/missions.ts", import.meta.url), "utf8");
const notifications = readFileSync(new URL("../lib/notifications.ts", import.meta.url), "utf8");
const controlRoomPage = readFileSync(new URL("../app/control-room/page.tsx", import.meta.url), "utf8");
const controlRoom = readFileSync(new URL("../components/control-room.tsx", import.meta.url), "utf8");

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
  assert.match(notifications, /status: "pending", providerMessageId, sentAt: null, error: null/);
  assert.match(notifications, /console\.info\("Send a Scout email accepted by provider", \{[\s\S]*notificationId:[\s\S]*kind:[\s\S]*attempt:[\s\S]*providerMessageId/);
  assert.doesNotMatch(notifications, /item\.status === "sent"\) throw new Error\("This email was already delivered\."\)/);
});

test("Control Room distinguishes email acceptance and permits an intentional resend", () => {
  assert.match(controlRoomPage, /providerAccepted: Boolean\(notification\.providerMessageId\)/);
  assert.match(controlRoom, /Accepted by email provider[\s\S]*delivery is not independently confirmed/);
  assert.match(controlRoom, /item\.channel === "email" && item\.providerAccepted \? "Resend" : "Retry"/);
});

test("SMS keeps its provider-callback delivery behavior", () => {
  assert.match(notifications, /sendSentSms\(\{ notificationId: queued\.id/);
  assert.match(notifications, /status: "pending", providerMessageId, error: null/);
  assert.match(notifications, /if \(item\.status === "sent"\) throw new Error\("This text was already delivered\."\)/);
});
