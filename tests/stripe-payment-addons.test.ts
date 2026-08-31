import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const addonService = readFileSync(new URL("../lib/stripe-payment-addons.ts", import.meta.url), "utf8");
const createCatch = addonService.slice(
  addonService.indexOf("  } catch (error) {"),
  addonService.indexOf("\n\n  const reconciled =", addonService.indexOf("  } catch (error) {")),
);
const outcomeUnknownBranch = createCatch.slice(
  createCatch.indexOf('if (offSessionCreateErrorDisposition(error) === "outcome_unknown")'),
  createCatch.indexOf("const [markedTerminal]"),
);

test("connection, API, rate-limit, and unknown create errors have an outcome-unknown disposition", () => {
  assert.match(addonService, /AMBIGUOUS_STRIPE_CREATE_ERROR_TYPES = new Set\(\[[\s\S]*"StripeConnectionError"[\s\S]*"StripeAPIError"[\s\S]*"StripeRateLimitError"/);
  assert.match(addonService, /statusCode === 429/);
  assert.match(addonService, /statusCode !== null && statusCode >= 500/);
  assert.match(addonService, /if \(typeof error !== "object" \|\| error === null\) return "outcome_unknown"/);
  assert.match(addonService, /return "outcome_unknown";\n}/);
});

test("an ambiguous off-session create never opens Checkout or marks the payment failed", () => {
  assert.match(outcomeUnknownBranch, /status: "processing"/);
  assert.match(outcomeUnknownBranch, /failureCode: OFF_SESSION_OUTCOME_UNKNOWN_CODE/);
  assert.match(outcomeUnknownBranch, /failedAt: null/);
  assert.match(outcomeUnknownBranch, /return \{ state: "processing" \}/);
  assert.doesNotMatch(outcomeUnknownBranch, /hostedFallback/);
  assert.doesNotMatch(outcomeUnknownBranch, /status: "failed"/);
});

test("an error carrying a still-processing PaymentIntent also cannot open Checkout", () => {
  assert.match(createCatch, /if \(failedIntent\) \{[\s\S]*reconcileAttemptIntent\(failedIntent\)/);
  assert.match(addonService, /if \(intent\.status === "processing"\) return \{ state: "processing" \}/);
});

test("outcome-unknown and stale in-flight attempts replay the same durable create request", () => {
  assert.match(addonService, /eq\(payments\.failureCode, OFF_SESSION_OUTCOME_UNKNOWN_CODE\)/);
  assert.match(addonService, /eq\(payments\.failureCode, OFF_SESSION_CREATING_CODE\),[\s\S]*lt\(payments\.updatedAt, staleCreate\)/);
  assert.match(addonService, /idempotencyKey: offSessionCreateIdempotencyKey\(row\.payment\.id\)/);
  assert.match(addonService, /return `payment-intent:\$\{paymentId}:off-session:v1`/);

  const createCall = addonService.slice(
    addonService.indexOf("intent = await stripe.paymentIntents.create"),
    addonService.indexOf("  } catch (error) {", addonService.indexOf("intent = await stripe.paymentIntents.create")),
  );
  assert.doesNotMatch(createCall, /row\.mission\.title/);
  assert.match(createCall, /description: addonDescription\(row\.payment\.kind\)/);
});

test("an outcome-unknown retry cannot divert to Checkout when the saved booking card stops validating", () => {
  assert.match(addonService, /stripeObjectId\(bookingIntent\.customer\) !== row\.payment\.stripeCustomerId[\s\S]*if \(canReplayCreate\) return \{ state: "processing" \};[\s\S]*return hostedFallback/);
});

test("only a definite invalid-request create failure can switch to hosted Checkout", () => {
  assert.match(addonService, /type === "StripeInvalidRequestError" \|\| rawType === "invalid_request_error"/);
  assert.match(createCatch, /failureCode: OFF_SESSION_TERMINAL_CODE/);
  assert.match(createCatch, /if \(!markedTerminal\)[\s\S]*return \{ state: "processing" \}/);
  assert.match(createCatch, /return hostedFallback\(row\.payment\.id, row\.payment\.customerId\);/);
});

test("the hourly recovery worker replays every outcome-unknown or stale create", () => {
  assert.match(addonService, /export async function reconcileAmbiguousOffSessionPayments/);
  assert.match(addonService, /eq\(payments\.failureCode, OFF_SESSION_OUTCOME_UNKNOWN_CODE\)/);
  assert.match(addonService, /lt\(payments\.updatedAt, staleCreate\)/);
  assert.match(addonService, /await attemptSavedPayment\(row\.id\)/);
});
