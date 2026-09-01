import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const paymentService = readFileSync(new URL("../lib/stripe-payments.ts", import.meta.url), "utf8");
const missionActions = readFileSync(new URL("../app/actions/missions.ts", import.meta.url), "utf8");
const cron = readFileSync(new URL("../app/api/cron/auto-complete/route.ts", import.meta.url), "utf8");

test("preferred Scout matching is recomputed across every itinerary leg before publication", () => {
  const snapshot = paymentService.slice(
    paymentService.indexOf("async function preferredScoutPublicationSnapshot"),
    paymentService.indexOf("function preferredScoutPublicationMatchSql"),
  );
  assert.match(snapshot, /eq\(missions\.bundleId, bundleId\)/);
  assert.match(snapshot, /legs\.every\(\(leg\) => isMissionEligibleForScout\(leg, scout\)\)/);
  assert.match(snapshot, /homeZip: scoutProfiles\.homeZip/);
  assert.match(snapshot, /serviceRadiusMiles: scoutProfiles\.serviceRadiusMiles/);
  assert.match(snapshot, /vehicleType: scoutProfiles\.vehicleType/);
  assert.match(snapshot, /canSee: scoutProfiles\.canSee/);
  assert.match(snapshot, /canMove: scoutProfiles\.canMove/);
  assert.match(snapshot, /canMeet: scoutProfiles\.canMeet/);
});

test("publication atomically rejects a stale preferred Scout match snapshot", () => {
  const matchSql = paymentService.slice(
    paymentService.indexOf("function preferredScoutPublicationMatchSql"),
    paymentService.indexOf("export async function ensureStripeCustomer"),
  );
  assert.match(matchSql, /ready_profile\.user_id = \$\{snapshot\.scoutId\}/);
  assert.match(matchSql, /ready_profile\.home_zip IS NOT DISTINCT FROM \$\{snapshot\.scout\.homeZip\}/);
  assert.match(matchSql, /ready_profile\.service_radius_miles = \$\{snapshot\.scout\.serviceRadiusMiles\}/);
  assert.match(matchSql, /ready_profile\.vehicle_type IS NOT DISTINCT FROM \$\{snapshot\.scout\.vehicleType\}/);
  assert.match(matchSql, /ready_profile\.can_see = \$\{snapshot\.scout\.canSee\}/);
  assert.match(matchSql, /ready_profile\.can_move = \$\{snapshot\.scout\.canMove\}/);
  assert.match(matchSql, /ready_profile\.can_meet = \$\{snapshot\.scout\.canMeet\}/);
  assert.match(matchSql, /\(SELECT COUNT\(\*\) FROM locked_missions\) = \$\{snapshot\.legs\.length\}/);
  assert.match(matchSql, /matching_leg\.type = \$\{leg\.type\}/);
  assert.match(matchSql, /matching_leg\.zip = \$\{leg\.zip\}/);
  assert.match(matchSql, /matching_leg\.large_item = \$\{leg\.largeItem\}/);
  assert.match(paymentService, /AND \$\{preferredScoutMissionMatch\}/);
});

test("an ineligible or changed preferred Scout is cleared and the mission broadcasts immediately", () => {
  assert.match(paymentService, /preferred_scout_id = CASE[\s\S]*ELSE NULL/);
  assert.match(paymentService, /preferred_scout_exclusive_until = CASE[\s\S]*ELSE NULL/);
  assert.match(paymentService, /preferred_scout_broadcast_at = CASE[\s\S]*THEN \$\{now\}/);
  assert.match(paymentService, /if \(published\) await alertEligibleScouts\(row\.mission\.id\)/);
});

test("bundle children inherit the root first-look result atomically", () => {
  assert.match(paymentService, /RETURNING root\.id, root\.bundle_id, root\.preferred_scout_id/);
  assert.match(paymentService, /preferred_scout_id = \(SELECT preferred_scout_id FROM published_root\)/);
  assert.match(paymentService, /preferred_scout_exclusive_until = \(SELECT preferred_scout_exclusive_until FROM published_root\)/);
  assert.match(paymentService, /preferred_scout_broadcast_at = \(SELECT preferred_scout_broadcast_at FROM published_root\)/);
});

test("preferred first-look publication requires the same complete Scout identity and profile basics", () => {
  assert.match(paymentService, /ready_user\.first_name/);
  assert.match(paymentService, /ready_user\.last_name/);
  assert.match(paymentService, /ready_user\.phone/);
  assert.match(paymentService, /ready_profile\.home_zip ~ '\^\[0-9\]\{5\}\$'/);
  assert.match(paymentService, /ready_profile\.service_radius_miles IN \(10, 25, 50, 75\)/);
  assert.match(paymentService, /ready_profile\.vehicle_type/);
  assert.match(paymentService, /ready_profile\.can_see OR ready_profile\.can_move OR ready_profile\.can_meet/);
  assert.match(paymentService, /ready_profile\.stripe_sync_completed_generation = ready_profile\.stripe_sync_generation/);
});

test("each initial, reopened, and preferred-window publication has a durable alert generation", () => {
  assert.match(paymentService, /alert_generation = root\.alert_generation \+ 1/);
  assert.match(missionActions, /WHEN \$\{status\} = 'open' THEN root\.alert_generation \+ 1/);
  assert.match(missionActions, /alertGeneration: sql`\$\{missions\.alertGeneration\} \+ 1`/);
  assert.match(cron, /alert_generation = mission\.alert_generation \+ 1/);
  assert.match(cron, /reconcileOpenMissionAlerts\(\)/);
});
