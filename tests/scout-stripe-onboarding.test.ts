import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const payoutAccount = readFileSync(new URL("../components/scout-payout-account.tsx", import.meta.url), "utf8");
const stripeConnectActions = readFileSync(new URL("../app/actions/stripe-connect.ts", import.meta.url), "utf8");
const stripeConnectService = readFileSync(new URL("../lib/stripe-connect-service.ts", import.meta.url), "utf8");

test("Scout chooses a personal or registered-business payout account before Stripe account creation", () => {
  assert.match(payoutAccount, /How should Stripe verify you\?/);
  assert.match(payoutAccount, /As myself/);
  assert.match(payoutAccount, /Most Scouts/);
  assert.match(payoutAccount, /Through my registered business/);
  assert.match(payoutAccount, /No LLC or business website is needed/);
  assert.match(payoutAccount, /openOnboarding\("individual"\)/);
  assert.match(payoutAccount, /openOnboarding\("company"\)/);
  assert.match(payoutAccount, /role="group"/);
  assert.match(payoutAccount, /choiceHeadingRef\.current\?\.focus\(\)/);
  assert.match(stripeConnectActions, /createScoutStripeAccountLink\(user\.id, payoutOwnerType\)/);
  assert.match(stripeConnectService, /if \(!payoutOwnerType\) throw new Error/);
});

test("Accounts v2 prefills an individual Scout without inventing a business website", () => {
  assert.match(stripeConnectService, /entity_type: "individual"/);
  assert.match(stripeConnectService, /given_name: row\.user\.firstName/);
  assert.match(stripeConnectService, /surname: row\.user\.lastName/);
  assert.match(stripeConnectService, /profile: \{\s*product_description: SCOUT_SERVICE_DESCRIPTION/);
  assert.doesNotMatch(stripeConnectService, /business_url:\s*"https:\/\/sendascout\.com"/);
  assert.doesNotMatch(stripeConnectService, /configuration:\s*\{\s*merchant:/);
});

test("Legacy Accounts v1 receives the same accurate individual or company choice", () => {
  assert.match(stripeConnectService, /business_type: payoutOwnerType/);
  assert.match(stripeConnectService, /business_profile: \{\s*product_description: SCOUT_SERVICE_DESCRIPTION/);
  assert.match(stripeConnectService, /individual: payoutOwnerType === "individual"/);
});

test("A stale retry cannot silently change an already-created Stripe legal entity", () => {
  assert.match(stripeConnectService, /syncStripeAccountProfile\(row\.profile\.stripeAccountId, apiVersion, payoutOwnerType\)/);
  assert.match(stripeConnectService, /requestedOwnerType && actualOwnerType !== requestedOwnerType/);
  assert.match(stripeConnectService, /already created with a different legal account type/);
  assert.match(payoutAccount, /router\.refresh\(\)/);
});

test("Stripe still collects eventual and future requirements up front", () => {
  assert.match(stripeConnectService, /collection_options: \{ fields: "eventually_due", future_requirements: "include" \}/);
});
