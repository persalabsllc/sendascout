import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateLegacyMissionAmounts,
  meetPriceForMinutes,
} from "../lib/mission-pricing-core.ts";

test("legacy See It pricing remains unchanged", () => {
  assert.deepEqual(calculateLegacyMissionAmounts("see"), {
    customerPriceCents: 2900,
    scoutPayoutCents: 1800,
    platformFeeCents: 1100,
    additionalRouteMiles: 0,
  });
});

test("legacy Meet It base and authorized-time pricing remain unchanged", () => {
  assert.deepEqual(calculateLegacyMissionAmounts("meet"), {
    customerPriceCents: 2900,
    scoutPayoutCents: 2000,
    platformFeeCents: 900,
    additionalRouteMiles: 0,
  });
  assert.deepEqual(meetPriceForMinutes(60), { customer: 2900, scout: 2000 });
  assert.deepEqual(meetPriceForMinutes(61), { customer: 3525, scout: 2450 });
  assert.deepEqual(meetPriceForMinutes(480), { customer: 20400, scout: 14600 });
  assert.deepEqual(meetPriceForMinutes(900), { customer: 20400, scout: 14600 });
});

test("legacy Move It includes three route miles and preserves per-mile pricing", () => {
  assert.deepEqual(calculateLegacyMissionAmounts("move", null), {
    customerPriceCents: 1900,
    scoutPayoutCents: 1000,
    platformFeeCents: 900,
    additionalRouteMiles: 0,
  });
  assert.deepEqual(calculateLegacyMissionAmounts("move", 3), {
    customerPriceCents: 1900,
    scoutPayoutCents: 1000,
    platformFeeCents: 900,
    additionalRouteMiles: 0,
  });
  assert.deepEqual(calculateLegacyMissionAmounts("move", 4), {
    customerPriceCents: 2075,
    scoutPayoutCents: 1125,
    platformFeeCents: 950,
    additionalRouteMiles: 1,
  });
});

test("legacy Move It large-item surcharge and Scout share remain unchanged", () => {
  assert.deepEqual(calculateLegacyMissionAmounts("move", 11, true), {
    customerPriceCents: 4300,
    scoutPayoutCents: 2800,
    platformFeeCents: 1500,
    additionalRouteMiles: 8,
  });
});
