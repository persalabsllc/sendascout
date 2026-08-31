import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const connectRoute = readFileSync(new URL("../app/api/webhooks/stripe/connect/route.ts", import.meta.url), "utf8");
const platformRoute = readFileSync(new URL("../app/api/webhooks/stripe/route.ts", import.meta.url), "utf8");
const connectedEvents = readFileSync(new URL("../lib/stripe-connected-events.ts", import.meta.url), "utf8");
const webhookLedger = readFileSync(new URL("../lib/stripe-webhooks.ts", import.meta.url), "utf8");
const connectService = readFileSync(new URL("../lib/stripe-connect-service.ts", import.meta.url), "utf8");

test("Connect endpoint selects the destination-specific secret and parser for each payload format", () => {
  assert.match(connectRoute, /payload\.object === "v2\.core\.event"/);
  assert.match(connectRoute, /STRIPE_CONNECT_THIN_WEBHOOK_SECRET/);
  assert.match(connectRoute, /STRIPE_CONNECT_SNAPSHOT_WEBHOOK_SECRET/);
  assert.match(connectRoute, /parseEventNotification\(rawBody, signature, secret\)/);
  assert.match(connectRoute, /webhooks\.constructEvent\(rawBody, signature, secret\)/);
  assert.doesNotMatch(connectRoute, /STRIPE_CONNECT_WEBHOOK_SECRET/);
  assert.match(connectRoute, /event\.livemode !== getStripeLivemode\(\)/);
});

test("platform webhook destination rejects cross-mode and connected-account events", () => {
  assert.match(platformRoute, /event\.livemode !== getStripeLivemode\(\)/);
  assert.match(platformRoute, /event\.account \|\| event\.context/);
  assert.match(platformRoute, /Connected-account events must use the Stripe Connect webhook destination/);
});

test("v2 account notifications resolve the related account and cover recipient readiness changes", () => {
  assert.match(connectedEvents, /"related_object" in event/);
  assert.match(connectedEvents, /event\.related_object\?\.id/);
  assert.match(connectedEvents, /v2\.core\.account\[configuration\.recipient\]/);
  assert.match(connectedEvents, /v2\.core\.account\[requirements\]/);
  assert.match(connectedEvents, /v2\.core\.account\[future_requirements\]/);
});

test("webhook ledger normalizes v1 epoch seconds and v2 ISO creation times", () => {
  assert.match(webhookLedger, /new Date\(event\.created\)/);
  assert.match(webhookLedger, /"related_object" in event/);
  assert.match(webhookLedger, /new Date\(event\.created \* 1000\)/);
  assert.match(webhookLedger, /relatedObject\?\.id/);
});

test("Accounts v2 balance settings run in Stripe context and verify Friday persistence", () => {
  assert.match(connectService, /apiVersion === "v2"[\s\S]*stripeContext: accountId/);
  assert.match(connectService, /stripeAccount: accountId/);
  assert.match(connectedEvents, /type === "balance_settings\.updated"/);
  assert.match(connectService, /await stripe\.balanceSettings\.update\([\s\S]*\}, connectedRequest\)/);
  assert.match(connectService, /await stripe\.balanceSettings\.retrieve\(\{\}, connectedRequest\)/);
  assert.match(connectService, /stripeBalanceSettingsUseRequiredFridaySchedule\(verifiedSettings\)/);
  assert.doesNotMatch(connectService, /weekly-payouts/);
});

test("connected payout events retrieve current state in the connected account context", () => {
  assert.match(connectedEvents, /payouts\.retrieve\(payout\.id, \{\}, \{ stripeContext: accountId \}\)/);
  assert.match(connectedEvents, /payoutStatus\(current\.status\)/);
  assert.match(connectedEvents, /current\.livemode !== livemode/);
  assert.doesNotMatch(connectedEvents, /payoutStatus\(payout\.status\)/);
});
