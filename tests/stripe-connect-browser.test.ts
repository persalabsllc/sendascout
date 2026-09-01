import assert from "node:assert/strict";
import test from "node:test";
import { isUnsupportedStripeEmbeddedBrowser } from "../lib/stripe-connect-browser.ts";

test("blocks Facebook and Instagram embedded webviews for hosted Stripe onboarding", () => {
  assert.equal(isUnsupportedStripeEmbeddedBrowser("Mozilla/5.0 [FBAN/FBIOS;FBAV/485.0.0]"), true);
  assert.equal(isUnsupportedStripeEmbeddedBrowser("Mozilla/5.0 [FB_IAB/FB4A;FBAV/485.0.0]"), true);
  assert.equal(isUnsupportedStripeEmbeddedBrowser("Mozilla/5.0 Instagram 400.0.0 iPhone"), true);
  assert.equal(isUnsupportedStripeEmbeddedBrowser("Mozilla/5.0 [FBAN/MessengerForiOS;FBAV/485.0.0]"), true);
});

test("allows standalone Safari and Chrome", () => {
  assert.equal(isUnsupportedStripeEmbeddedBrowser("Mozilla/5.0 Version/18.0 Mobile/15E148 Safari/604.1"), false);
  assert.equal(isUnsupportedStripeEmbeddedBrowser("Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36"), false);
  assert.equal(isUnsupportedStripeEmbeddedBrowser(null), false);
});
