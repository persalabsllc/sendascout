import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const scoutDashboardPage = readFileSync(new URL("../app/dashboard/scout/page.tsx", import.meta.url), "utf8");
const missionBoardPage = readFileSync(new URL("../app/dashboard/scout/missions/page.tsx", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../components/dashboard.tsx", import.meta.url), "utf8");
const payoutBanner = readFileSync(new URL("../components/scout-payout-required-banner.tsx", import.meta.url), "utf8");
const stripeConnectActions = readFileSync(new URL("../app/actions/stripe-connect.ts", import.meta.url), "utf8");
const stripeConnectService = readFileSync(new URL("../lib/stripe-connect-service.ts", import.meta.url), "utf8");

test("Scout dashboard uses the same Stripe readiness gate for missions and its setup banner", () => {
  assert.match(scoutDashboardPage, /const payoutReady = scoutConnectReady\(profile, stripeLivemode\)/);
  assert.match(scoutDashboardPage, /profile\.status === "approved" && payoutReady/);
  assert.match(scoutDashboardPage, /scoutPayoutReady=\{payoutReady\}/);
  assert.match(dashboard, /!scoutPayoutReady && <ScoutPayoutRequiredBanner/);
  assert.match(dashboard, /Finish payout setup before matching missions can appear\./);
});

test("Refreshing Stripe status immediately refreshes both Scout mission surfaces", () => {
  assert.match(stripeConnectActions, /revalidatePath\("\/dashboard\/scout"\)/);
  assert.match(stripeConnectActions, /revalidatePath\("\/dashboard\/scout\/missions"\)/);
});

test("A legacy approved Scout receives existing mission alerts when payouts become ready", () => {
  assert.match(stripeConnectService, /const wasReady = scoutConnectReady\(existing, expectedLivemode\)/);
  assert.match(stripeConnectService, /updated\.status === "approved" && !wasReady && scoutConnectReady\(updated, expectedLivemode\)/);
  assert.match(stripeConnectService, /await alertScoutToOpenMissions\(updated\.userId\)/);
});

test("Mission Board makes an incomplete payout account an explicit clickable blocker", () => {
  assert.match(missionBoardPage, /const payoutReady = Boolean\(profile && scoutConnectReady\(profile, stripeLivemode\)\)/);
  assert.match(missionBoardPage, /!payoutReady && <ScoutPayoutRequiredBanner/);
  assert.match(missionBoardPage, /Finish Stripe payout setup before open missions appear\./);
  assert.match(payoutBanner, /href="\/dashboard\/scout\/earnings"/);
  assert.match(payoutBanner, /Finish payout setup to unlock missions/);
  assert.match(payoutBanner, /Open missions stay hidden until Stripe confirms/);
  assert.match(payoutBanner, /Set up payouts/);
});

test("Payout banner explains that normal approval and matching rules still apply", () => {
  assert.match(payoutBanner, /applicationApproved/);
  assert.match(payoutBanner, /Matching missions appear after your application is approved/);
});
