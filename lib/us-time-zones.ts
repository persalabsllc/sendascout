export const DEFAULT_MISSION_TIME_ZONE = "America/New_York";

export const US_TIME_ZONE_OPTIONS = [
  { value: "America/New_York", label: "Eastern Time" },
  { value: "America/Chicago", label: "Central Time" },
  { value: "America/Denver", label: "Mountain Time" },
  { value: "America/Phoenix", label: "Arizona Time" },
  { value: "America/Los_Angeles", label: "Pacific Time" },
  { value: "America/Anchorage", label: "Alaska Time" },
  { value: "Pacific/Honolulu", label: "Hawaii Time" },
] as const;

export type MissionTimeZone = (typeof US_TIME_ZONE_OPTIONS)[number]["value"];

const timeZones = new Set<string>(US_TIME_ZONE_OPTIONS.map((option) => option.value));

const centralStates = new Set(["AL", "AR", "IA", "IL", "KS", "LA", "MN", "MO", "MS", "ND", "NE", "OK", "SD", "TN", "TX", "WI"]);
const mountainStates = new Set(["CO", "ID", "MT", "NM", "UT", "WY"]);
const pacificStates = new Set(["CA", "NV", "OR", "WA"]);

export function normalizeMissionTimeZone(value: string | null | undefined): MissionTimeZone {
  return timeZones.has(value ?? "") ? value as MissionTimeZone : DEFAULT_MISSION_TIME_ZONE;
}

export function isMissionTimeZone(value: string | null | undefined): value is MissionTimeZone {
  return timeZones.has(value ?? "");
}

export function defaultMissionTimeZoneForState(state: string | null | undefined): MissionTimeZone {
  const normalized = state?.trim().toUpperCase() ?? "";
  if (normalized === "AK") return "America/Anchorage";
  if (normalized === "AZ") return "America/Phoenix";
  if (normalized === "HI") return "Pacific/Honolulu";
  if (centralStates.has(normalized)) return "America/Chicago";
  if (mountainStates.has(normalized)) return "America/Denver";
  if (pacificStates.has(normalized)) return "America/Los_Angeles";
  return DEFAULT_MISSION_TIME_ZONE;
}

export function missionTimeZoneLabel(value: string | null | undefined) {
  const normalized = normalizeMissionTimeZone(value);
  return US_TIME_ZONE_OPTIONS.find((option) => option.value === normalized)?.label ?? "Eastern Time";
}
