import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  verifiedIdentityFromV1Account,
  verifiedIdentityFromV2Account,
} from "../lib/stripe-connect.ts";

function source(relativePath: string) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

const autoApproval = source("lib/scout-auto-approval.ts");
const connectService = source("lib/stripe-connect-service.ts");
const missions = source("app/actions/missions.ts");
const controlRoom = source("components/control-room-scouts.tsx");
const profileActions = source("app/actions/profile.ts");
const paymentService = source("lib/stripe-payments.ts");
const notifications = source("lib/notifications.ts");

test("v1 identity requires Stripe's explicit verified state", () => {
  const verified = verifiedIdentityFromV1Account({
    id: "acct_v1",
    business_type: "individual",
    individual: {
      id: "person_v1",
      first_name: "Avery",
      last_name: "Scout",
      verification: { status: "verified" },
    },
  });
  assert.deepEqual(verified, { fullName: "Avery Scout", reference: "person_v1" });

  assert.equal(verifiedIdentityFromV1Account({
    id: "acct_v1",
    business_type: "individual",
    individual: {
      id: "person_v1",
      first_name: "Avery",
      last_name: "Scout",
      verification: { status: "pending" },
    },
  }), null);
});

test("company accounts use only the verified primary representative", () => {
  const account = { id: "acct_company", business_type: "company" };
  const representative = {
    id: "person_rep",
    first_name: "Robin",
    last_name: "Scout",
    relationship: { representative: true },
    verification: { status: "verified" },
  };
  assert.deepEqual(verifiedIdentityFromV1Account(account, representative), {
    fullName: "Robin Scout",
    reference: "person_rep",
  });
  assert.equal(verifiedIdentityFromV1Account(account, {
    ...representative,
    relationship: { representative: false },
  }), null);
});

test("v2 identity is never inferred before canonical recipient readiness", () => {
  const account = {
    id: "acct_v2",
    identity: {
      entity_type: "individual",
      individual: { id: "person_v2", given_name: "Taylor", surname: "Scout" },
    },
  };
  assert.equal(verifiedIdentityFromV2Account(account, false), null);
  assert.deepEqual(verifiedIdentityFromV2Account(account, true), {
    fullName: "Taylor Scout",
    reference: "person_v2",
  });
});

test("Stripe sync owns identity evidence and invokes automatic approval", () => {
  assert.match(connectService, /summary\.status === "ready"/);
  assert.match(connectService, /verifiedIdentityFromV2Account\(account, summary\.status === "ready", representative\)/);
  assert.match(connectService, /verifiedIdentityFromV1Account\(account, representative\)/);
  assert.match(connectService, /identityProvider = `stripe_connect_\$\{apiVersion\}`/);
  assert.match(connectService, /identityVerifiedBy: null/);
  assert.match(connectService, /identityVerificationReference: verifiedIdentity\?\.reference \?\? null/);
  assert.match(connectService, /identityVerifiedName: verifiedIdentity\?\.fullName \?\? null/);
  assert.match(connectService, /await tryAutoApproveScout\(updated\.userId\)/);
  assert.match(connectService, /notInArray\(scoutProfiles\.identityProvider, \["stripe_connect_v1", "stripe_connect_v2"\]\)/);
  assert.match(connectService, /for await \(const person of stripe\.accounts\.listPersons/);
  assert.match(connectService, /for await \(const person of stripe\.v2\.core\.accounts\.persons\.list/);
  assert.match(connectService, /MAX_COMPANY_PERSONS_TO_SCAN = 100/);
});

test("auto approval is atomic, idempotent and excludes paused or rejected Scouts", () => {
  assert.match(autoApproval, /inArray\(scoutProfiles\.status, \["applicant", "review"\]\)/);
  assert.match(autoApproval, /inArray\(scoutProfiles\.identityProvider, \["stripe_connect_v1", "stripe_connect_v2"\]\)/);
  assert.match(autoApproval, /isNull\(scoutProfiles\.identityVerifiedBy\)/);
  assert.match(autoApproval, /approval_user\.role = 'scout'/);
  assert.match(autoApproval, /approval_user\.status = 'active'/);
  assert.match(autoApproval, /jsonb_array_length\(\$\{scoutProfiles\.stripeRequirementsPendingVerification\}\) = 0/);
  assert.match(autoApproval, /returning\(\{\s*profileId: scoutProfiles\.id,\s*userId: scoutProfiles\.userId/);
  assert.match(autoApproval, /notifyUserOnce/);
  assert.match(autoApproval, /NOT EXISTS \([\s\S]*approval_notice[\s\S]*kind = 'scout_approved'/);
  assert.match(autoApproval, /if \(missionAlertsBackfilled\)/);
  assert.match(autoApproval, /recoverable_delivery\.kind IN \('scout_approved', 'new_mission'\)/);
  assert.match(notifications, /const target = missionAlertTarget\(mission, scoutUserId\)/);
  assert.match(notifications, /dedupeScope: target\.scope/);
  assert.match(notifications, /onConflictDoNothing\(\{ target: notifications\.dedupeKey \}\)/);
  assert.match(notifications, /scoutStillEligibleForMissionAlert/);
  assert.match(notifications, /channel: "sms" as const/);
  assert.doesNotMatch(autoApproval, /eq\(scoutProfiles\.status, "paused"\)|eq\(scoutProfiles\.status, "rejected"\)/);
});

test("manual identity and initial applicant approval controls are removed", () => {
  assert.doesNotMatch(missions, /adminRecordScoutIdentity|manual_admin_review/);
  assert.doesNotMatch(controlRoom, /Record ID verified|adminRecordScoutIdentity/);
  assert.match(controlRoom, /Approves automatically when ready/);
  assert.match(controlRoom, /scout\.status === "paused"/);
  assert.match(controlRoom, /Restore access/);
  assert.match(controlRoom, /Stripe may clear identity without requesting a photo ID/);
  assert.match(missions, /Only a paused Scout can be restored manually/);
  assert.match(missions, /scoutProfileClaimReadinessConditions\(getStripeLivemode\(\), \["paused"\]\)/);
  assert.match(missions, /restore_user\.status = 'active'/);
});

test("changing a headshot no longer revokes Stripe identity and uses one CAS update", () => {
  const start = profileActions.indexOf("export async function saveScoutHeadshot");
  const action = profileActions.slice(start);
  assert.doesNotMatch(action, /needsIdentityReview|identityCheck:|identityVerifiedAt:|status: existing\.status === "approved"/);
  assert.match(action, /headshotPath} IS NOT DISTINCT FROM \$\{existing\.headshotPath\}/);
  assert.match(action, /const \[savedPhoto\] = await db\.update\(scoutProfiles\)/);
  assert.doesNotMatch(action, /db\.batch\(\[lockProfile, savePhoto\]\)/);
  assert.match(action, /await tryAutoApproveScout\(user\.id\)/);
});

test("payment publication drops an unavailable preferred Scout instead of stranding paid work", () => {
  assert.match(paymentService, /preferred_scout_readiness AS MATERIALIZED/);
  assert.match(paymentService, /ready_user\.legal_version = \$\{LEGAL_VERSION\}/);
  assert.match(paymentService, /ready_profile\.identity_provider IN \('stripe_connect_v1', 'stripe_connect_v2'\)/);
  assert.match(paymentService, /preferred_scout_id = CASE[\s\S]*EXISTS \(SELECT 1 FROM preferred_scout_readiness\)[\s\S]*ELSE NULL/);
  assert.match(paymentService, /preferred_scout_broadcast_at = CASE[\s\S]*NOT EXISTS \(SELECT 1 FROM preferred_scout_readiness\)[\s\S]*THEN \$\{now\}/);
});
