import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatDateTime, localDateTimeToUtc } from "../lib/time.ts";
import { defaultMissionTimeZoneForState, isMissionTimeZone } from "../lib/us-time-zones.ts";

test("mission scheduling converts each supported U.S. time zone independently", () => {
  assert.equal(localDateTimeToUtc("2026-08-30T12:00", "America/New_York").toISOString(), "2026-08-30T16:00:00.000Z");
  assert.equal(localDateTimeToUtc("2026-08-30T12:00", "America/Chicago").toISOString(), "2026-08-30T17:00:00.000Z");
  assert.equal(localDateTimeToUtc("2026-08-30T12:00", "America/Los_Angeles").toISOString(), "2026-08-30T19:00:00.000Z");
  assert.match(formatDateTime("2026-08-30T19:00:00.000Z", "America/Los_Angeles"), /12:00 PM PDT/);
  assert.throws(() => localDateTimeToUtc("2026-03-08T02:30", "America/New_York"), /does not exist/i);
});

test("state defaults cover the major U.S. mission time zones", () => {
  assert.equal(defaultMissionTimeZoneForState("NC"), "America/New_York");
  assert.equal(defaultMissionTimeZoneForState("TX"), "America/Chicago");
  assert.equal(defaultMissionTimeZoneForState("CO"), "America/Denver");
  assert.equal(defaultMissionTimeZoneForState("AZ"), "America/Phoenix");
  assert.equal(defaultMissionTimeZoneForState("CA"), "America/Los_Angeles");
  assert.equal(defaultMissionTimeZoneForState("AK"), "America/Anchorage");
  assert.equal(defaultMissionTimeZoneForState("HI"), "Pacific/Honolulu");
  assert.equal(isMissionTimeZone("Europe/London"), false);
});

test("public launch copy is nationwide and See It or Meet It retain customer state", () => {
  const home = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const onboarding = readFileSync(new URL("../components/onboarding-form.tsx", import.meta.url), "utf8");
  const action = readFileSync(new URL("../app/actions/onboarding.ts", import.meta.url), "utf8");
  const pricing = readFileSync(new URL("../lib/mission-pricing.ts", import.meta.url), "utf8");

  assert.doesNotMatch(home, /Starting in Eastern NC/i);
  assert.match(home, /communities across the U\.S\./i);
  assert.doesNotMatch(onboarding, /Eastern North Carolina soft launch/i);
  assert.match(onboarding, /Mission time zone/);
  assert.match(action, /input\.type === "move" \? input\.pickupState : input\.state/);
  assert.match(pricing, /input\.city, input\.state, input\.zip/);
});
