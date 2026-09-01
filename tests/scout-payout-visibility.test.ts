import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const scoutDashboardPage = readFileSync(new URL("../app/dashboard/scout/page.tsx", import.meta.url), "utf8");
const missionBoardPage = readFileSync(new URL("../app/dashboard/scout/missions/page.tsx", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../components/dashboard.tsx", import.meta.url), "utf8");
const payoutBanner = readFileSync(new URL("../components/scout-payout-required-banner.tsx", import.meta.url), "utf8");
const stripeConnectActions = readFileSync(new URL("../app/actions/stripe-connect.ts", import.meta.url), "utf8");
const stripeConnectService = readFileSync(new URL("../lib/stripe-connect-service.ts", import.meta.url), "utf8");
const missionDetailPage = readFileSync(new URL("../app/dashboard/missions/[id]/page.tsx", import.meta.url), "utf8");
const missionWorkspace = readFileSync(new URL("../components/mission-workspace.tsx", import.meta.url), "utf8");

test("Scout dashboard exposes matching missions while Stripe readiness gates claiming", () => {
  assert.match(scoutDashboardPage, /const payoutReady = scoutConnectReady\(profile, stripeLivemode\)/);
  assert.match(scoutDashboardPage, /const canBrowseOpen = scoutCanBrowseOpenMissions\(profile\)/);
  assert.match(scoutDashboardPage, /canBrowseOpen[\s\S]*eq\(missions\.status, "open"\)[\s\S]*eq\(missions\.paymentStatus, "paid"\)/);
  assert.match(scoutDashboardPage, /scoutPayoutReady=\{payoutReady\}/);
  assert.match(dashboard, /canBrowseOpen && !scoutPayoutReady && <ScoutPayoutRequiredBanner/);
  assert.match(dashboard, /Finish payout setup before claiming one\./);
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

test("Mission Board makes an incomplete payout account an explicit claim blocker", () => {
  assert.match(missionBoardPage, /const payoutReady = scoutConnectReady\(profile, stripeLivemode\)/);
  assert.match(missionBoardPage, /const canBrowseOpen = scoutCanBrowseOpenMissions\(profile\)/);
  assert.match(missionBoardPage, /canBrowseOpen && !payoutReady && <ScoutPayoutRequiredBanner/);
  assert.doesNotMatch(missionBoardPage, /before open missions appear/i);
  assert.match(payoutBanner, /href="\/dashboard\/scout\/earnings"/);
  assert.match(payoutBanner, /Finish payout setup before claiming/);
  assert.match(payoutBanner, /You can browse matching opportunities now/);
  assert.match(payoutBanner, /Set up payouts/);
});

test("Scout mission amounts emphasize earnings without comparing customer pricing", () => {
  assert.doesNotMatch(missionBoardPage, /not the customer price/i);
  assert.ok(missionBoardPage.includes("Each amount shown is what you&apos;ll earn for completing that mission."));
  assert.ok(missionBoardPage.includes("You&apos;ll earn"));
  assert.ok(dashboard.includes("You&apos;ll earn"));
  assert.match(missionDetailPage, /customerDeltaCents: role !== "scout" \? order\.customerDeltaCents : 0/);
  assert.match(missionWorkspace, /role === "scout" \? `You’ll earn: \+\$\{money\(order\.scoutDeltaCents\)\}` : `Additional charge/);
  assert.doesNotMatch(missionWorkspace, /Customer: \+\{money\(order\.customerDeltaCents\)\} · Scout payout/);
});

test("Payout banner explains that normal approval and matching rules still apply", () => {
  assert.match(payoutBanner, /applicationApproved/);
  assert.match(payoutBanner, /Claiming unlocks after approval and Stripe payout readiness/);
});
