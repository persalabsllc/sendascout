import "server-only";

import { distanceBetweenZips } from "@/lib/geography";
import { evaluateScoutMissionEligibility, type ScoutMissionEligibilityReason } from "@/lib/scout-matching-core";

export type { ScoutMissionEligibilityReason } from "@/lib/scout-matching-core";

type MissionForMatching = { type: "see" | "move" | "meet"; zip: string; largeItem: boolean };
type ScoutForMatching = {
  homeZip: string | null;
  serviceRadiusMiles: number;
  vehicleType: string | null;
  canSee: boolean;
  canMove: boolean;
  canMeet: boolean;
};

export function isMissionEligibleForScout(mission: MissionForMatching, scout: ScoutForMatching) {
  return scoutMissionEligibility(mission, scout) === null;
}

export function scoutMissionEligibility(mission: MissionForMatching, scout: ScoutForMatching): ScoutMissionEligibilityReason | null {
  const distance = distanceBetweenZips(scout.homeZip, mission.zip);
  if (distance === null || distance > scout.serviceRadiusMiles) return "outside_zone";
  return evaluateScoutMissionEligibility(mission, scout, distance).reason;
}
