import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const payoutAccount = readFileSync(new URL("../components/scout-payout-account.tsx", import.meta.url), "utf8");
const stripeConnectActions = readFileSync(new URL("../app/actions/stripe-connect.ts", import.meta.url), "utf8");
const stripeConnectService = readFileSync(new URL("../lib/stripe-connect-service.ts", import.meta.url), "utf8");
const stripeConnectReturn = readFileSync(new URL("../app/api/stripe/connect/return/route.ts", import.meta.url), "utf8");
const stripeConnectTelemetry = readFileSync(new URL("../lib/stripe-connect-telemetry.ts", import.meta.url), "utf8");
const stripeConnectedEvents = readFileSync(new URL("../lib/stripe-connected-events.ts", import.meta.url), "utf8");

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

test("historical v1 accounts missing an API discriminator are repaired automatically before sync", () => {
  const repairStart = stripeConnectService.indexOf("async function resolveHistoricalStripeAccountApiVersion");
  const repairEnd = stripeConnectService.indexOf("export async function getOrCreateScoutStripeAccount", repairStart);
  const repair = stripeConnectService.slice(repairStart, repairEnd);
  const byIdStart = stripeConnectService.indexOf("export async function syncStripeAccountById");
  const byIdEnd = stripeConnectService.indexOf("export async function reconcileScoutPayoutReadiness", byIdStart);
  const byId = stripeConnectService.slice(byIdStart, byIdEnd);

  assert.ok(repairStart >= 0 && repairEnd > repairStart);
  assert.match(repair, /stripeAccountApiVersion: "v1"/);
  assert.match(repair, /stripeSyncGeneration: sql`\$\{scoutProfiles\.stripeSyncGeneration\} \+ 1`/);
  assert.match(repair, /isNull\(scoutProfiles\.stripeAccountApiVersion\)/);
  assert.match(repair, /eq\(scoutProfiles\.stripeAccountId, accountId\)/);
  assert.match(repair, /return storedAccountApiVersion\(current\?\.apiVersion \?\? null\)/);
  assert.match(byId, /resolveHistoricalStripeAccountApiVersion\(accountId\)/);
  assert.match(byId, /syncStripeAccountProfile\(accountId, apiVersion\)/);
  assert.match(stripeConnectService, /isNull\(scoutProfiles\.stripeAccountApiVersion\)/);
  assert.match(stripeConnectService, /if \(await syncStripeAccountById\(row\.accountId\)\) synced \+= 1/);
});

test("A stale retry cannot silently change an already-created Stripe legal entity", () => {
  assert.match(stripeConnectService, /syncStripeAccountProfile\(row\.profile\.stripeAccountId, apiVersion, payoutOwnerType\)/);
  assert.match(stripeConnectService, /requestedOwnerType && actualOwnerType !== requestedOwnerType/);
  assert.match(stripeConnectService, /already created with a different legal account type/);
  assert.match(payoutAccount, /router\.refresh\(\)/);
});

test("Stripe collects only requirements that are currently due during hosted onboarding", () => {
  assert.equal(stripeConnectService.match(/collection_options: \{ fields: "currently_due" \}/g)?.length, 3);
  assert.doesNotMatch(stripeConnectService, /fields: "eventually_due"/);
  assert.doesNotMatch(stripeConnectService, /future_requirements: "include"/);
});

test("Facebook, Instagram, and Messenger embedded browsers get a supported-browser handoff", () => {
  assert.match(payoutAccount, /isUnsupportedStripeEmbeddedBrowser\(navigator\.userAgent\)/);
  assert.match(payoutAccount, /Open this page in Safari or Chrome/);
  assert.match(payoutAccount, /Stripe verification cannot run inside Facebook, Instagram, or Messenger/);
  assert.match(payoutAccount, /Copy this page link/);
  assert.match(payoutAccount, /mailto:support@sendascout\.com/);
  assert.match(stripeConnectActions, /reason: "embedded_browser"/);
  assert.match(stripeConnectActions, /start_blocked_embedded_browser/);
});

test("Stripe funnel telemetry logs redacted references and requirement counts", () => {
  assert.match(stripeConnectTelemetry, /createHash\("sha256"\)/);
  assert.match(stripeConnectTelemetry, /scoutRef: stripeConnectTelemetryRef\(userId\)/);
  assert.match(stripeConnectTelemetry, /accountRef: stripeConnectTelemetryRef\(accountId\)/);
  assert.doesNotMatch(stripeConnectTelemetry, /userAgent\??:/);
  assert.match(stripeConnectService, /"link_created"/);
  assert.match(stripeConnectService, /"status_synced"/);
  assert.match(stripeConnectReturn, /"return_synced"/);
  assert.match(stripeConnectReturn, /currentlyDueCount/);
});

test("Accounts v2 completion and representative events resync their parent account", () => {
  assert.match(stripeConnectedEvents, /type === "v2\.core\.account_link\.returned"/);
  assert.match(stripeConnectedEvents, /type === "v2\.core\.account_person\.created"/);
  assert.match(stripeConnectedEvents, /type === "v2\.core\.account_person\.updated"/);
  assert.match(stripeConnectedEvents, /type === "v2\.core\.account_person\.deleted"/);
  assert.match(stripeConnectedEvents, /await event\.fetchEvent\(\)/);
  assert.match(stripeConnectedEvents, /fullEvent\.data\?\.account_id/);
  assert.match(stripeConnectedEvents, /await syncStripeAccountById\(accountId\)/);
  assert.match(stripeConnectedEvents, /withStripeWebhookLedger\(event, scope/);
});
