export type ScoutMissionEligibilityReason = "mission_type" | "outside_zone" | "vehicle";

type MissionForEligibility = { type: "see" | "move" | "meet"; largeItem: boolean };
type ScoutForEligibility = {
  vehicleType: string | null;
  canSee: boolean;
  canMove: boolean;
  canMeet: boolean;
};

export function evaluateScoutMissionEligibility(
  mission: MissionForEligibility,
  scout: ScoutForEligibility,
  distanceMiles: number | null,
): { eligible: true; reason: null } | { eligible: false; reason: ScoutMissionEligibilityReason } {
  const hasCapability = mission.type === "see" ? scout.canSee : mission.type === "move" ? scout.canMove : scout.canMeet;
  if (!hasCapability) return { eligible: false, reason: "mission_type" };
  if (distanceMiles === null) return { eligible: false, reason: "outside_zone" };
  if (mission.type === "move" && mission.largeItem && !["suv", "pickup truck", "van"].includes(scout.vehicleType?.trim().toLowerCase() ?? "")) {
    return { eligible: false, reason: "vehicle" };
  }
  return { eligible: true, reason: null };
}
