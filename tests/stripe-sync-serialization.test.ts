import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

const schema = source("db/schema.ts");
const migration = source("db/migrations/0018_notification_dedupe.sql");
const connectService = source("lib/stripe-connect-service.ts");
const connectReadiness = source("lib/stripe-connect.ts");
const claimReadiness = source("lib/scout-claim-readiness.ts");
const autoApproval = source("lib/scout-auto-approval.ts");
const missionActions = source("app/actions/missions.ts");

test("Stripe account synchronization has a recoverable exclusive lease", () => {
  assert.match(schema, /stripeSyncGeneration: integer\("stripe_sync_generation"\)/);
  assert.match(schema, /stripeSyncCompletedGeneration: integer\("stripe_sync_completed_generation"\)/);
  assert.match(schema, /stripeSyncLeaseToken: text\("stripe_sync_lease_token"\)/);
  assert.match(schema, /stripeSyncLeaseExpiresAt: timestamp\("stripe_sync_lease_expires_at"/);
  assert.match(migration, /ADD COLUMN "stripe_sync_completed_generation"/);
  assert.match(migration, /ADD COLUMN "stripe_sync_lease_token"/);
  assert.match(migration, /scout_profiles_stripe_sync_lease_check/);

  assert.match(connectService, /stripeSyncGeneration: sql`\$\{scoutProfiles\.stripeSyncGeneration\} \+ 1`/);
  assert.match(connectService, /stripeSyncLeaseToken: leaseToken/);
  assert.match(connectService, /stripeSyncLeaseExpiresAt} <= \$\{leaseStartedAt\}/);
  assert.match(connectService, /eq\(scoutProfiles\.stripeSyncLeaseToken, leaseToken\)/);
  assert.match(connectService, /eq\(scoutProfiles\.stripeSyncGeneration, syncGeneration\)/);
  assert.match(connectService, /stripeSyncCompletedGeneration: syncGeneration/);
  assert.match(connectService, /if \(!updated\) continue/);
  assert.match(connectService, /stripeSyncCompletedGeneration} < \$\{scoutProfiles\.stripeSyncGeneration\}/);
});

test("every approval and claim surface fails closed while a Stripe sync is pending", () => {
  assert.match(connectReadiness, /stripeSyncCompletedGeneration === profile\.stripeSyncGeneration/);
  assert.match(claimReadiness, /eq\(scoutProfiles\.stripeSyncCompletedGeneration, scoutProfiles\.stripeSyncGeneration\)/);
  assert.match(autoApproval, /eq\(scoutProfiles\.stripeSyncCompletedGeneration, scoutProfiles\.stripeSyncGeneration\)/);
  assert.equal(
    missionActions.match(/approved_profile\.stripe_sync_completed_generation = approved_profile\.stripe_sync_generation/g)?.length,
    2,
  );
});
