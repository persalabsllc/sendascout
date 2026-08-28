import "server-only";

import { isWithinScoutZone } from "@/lib/geography";

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
  const hasCapability = mission.type === "see" ? scout.canSee : mission.type === "move" ? scout.canMove : scout.canMeet;
  if (!hasCapability || !isWithinScoutZone(scout.homeZip, mission.zip, scout.serviceRadiusMiles)) return false;
  if (mission.type !== "move" || !mission.largeItem) return true;
  return ["suv", "pickup truck", "van"].includes(scout.vehicleType?.trim().toLowerCase() ?? "");
}
