import assert from "node:assert/strict";
import test from "node:test";
import { evaluateScoutMissionEligibility } from "../lib/scout-matching-core.ts";

const carScout = { vehicleType: "Car", canSee: true, canMove: true, canMeet: true };

test("mission publication time never changes current Scout eligibility", () => {
  const olderMission = { type: "move" as const, largeItem: false, createdAt: new Date("2026-08-01T12:00:00Z") };
  const newerMission = { ...olderMission, createdAt: new Date("2026-08-30T12:00:00Z") };
  assert.deepEqual(evaluateScoutMissionEligibility(olderMission, carScout, 5), { eligible: true, reason: null });
  assert.deepEqual(evaluateScoutMissionEligibility(newerMission, carScout, 5), { eligible: true, reason: null });
});

test("a car remains eligible for a small Move It mission", () => {
  assert.deepEqual(evaluateScoutMissionEligibility({ type: "move", largeItem: false }, carScout, 17), { eligible: true, reason: null });
});

test("a large-item Move It mission requires an SUV, pickup, or van", () => {
  assert.deepEqual(evaluateScoutMissionEligibility({ type: "move", largeItem: true }, carScout, 5), { eligible: false, reason: "vehicle" });
  assert.deepEqual(evaluateScoutMissionEligibility({ type: "move", largeItem: true }, { ...carScout, vehicleType: "SUV" }, 5), { eligible: true, reason: null });
});

test("mission-type and travel-zone gates remain explicit", () => {
  assert.deepEqual(evaluateScoutMissionEligibility({ type: "see", largeItem: false }, { ...carScout, canSee: false }, 5), { eligible: false, reason: "mission_type" });
  assert.deepEqual(evaluateScoutMissionEligibility({ type: "meet", largeItem: false }, carScout, null), { eligible: false, reason: "outside_zone" });
});
