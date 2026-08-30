export const CASE_KINDS = [
  "customer_cancellation",
  "customer_problem",
  "scout_customer_no_show",
  "scout_safety_concern",
] as const;

export type MissionCaseKind = typeof CASE_KINDS[number];

export type OperationalMissionStatus =
  | "draft" | "open" | "claimed" | "en_route" | "onsite"
  | "en_route_pickup" | "at_pickup" | "en_route_dropoff" | "at_dropoff"
  | "submitted" | "completed" | "cancelled" | "disputed";

export type MissionCaseResolution = "resume" | "cancel" | "complete" | "hold";

export function caseResolutionIsFinal(resolution: MissionCaseResolution) {
  return resolution !== "hold";
}

export function remainingCaseAdjustmentCents(maximumCents: number, previouslyRecordedCents: number) {
  return Math.max(0, maximumCents - Math.max(0, previouslyRecordedCents));
}

export function cancellationMode(status: OperationalMissionStatus) {
  if (["draft", "open", "claimed"].includes(status)) return "immediate" as const;
  if (["cancelled", "completed"].includes(status)) return "unavailable" as const;
  return "review" as const;
}

export function bundledCancellationMode(status: OperationalMissionStatus, activeSequence: number) {
  const mode = cancellationMode(status);
  if (mode === "immediate" && activeSequence > 1) return "review" as const;
  return mode;
}

export function caseKindAllowed(role: "customer" | "scout" | "admin", kind: MissionCaseKind) {
  if (role === "admin") return true;
  if (kind.startsWith("customer_")) return role === "customer";
  return role === "scout";
}

export function missionStatusAfterResolution(
  resolution: "resume" | "cancel" | "complete" | "hold",
  previousStatus: OperationalMissionStatus,
) {
  if (resolution === "cancel") return "cancelled" as const;
  if (resolution === "complete") return "completed" as const;
  if (resolution === "hold") return "disputed" as const;
  return previousStatus === "disputed" ? "claimed" as const : previousStatus;
}

export function bundleStatusAfterResolution(
  resolution: "resume" | "cancel" | "complete" | "hold",
  previousStatus: OperationalMissionStatus,
  activeSequence: number,
) {
  if (resolution === "cancel") return "cancelled" as const;
  if (resolution === "complete") return "completed" as const;
  if (resolution === "hold") return "disputed" as const;
  if (previousStatus === "draft") return "draft" as const;
  if (previousStatus === "open") return "open" as const;
  if (previousStatus === "completed") return "completed" as const;
  if (previousStatus === "submitted") return "submitted" as const;
  if (previousStatus === "cancelled") return "cancelled" as const;
  return activeSequence === 1 && previousStatus === "claimed" ? "claimed" as const : "in_progress" as const;
}

export function caseLabel(kind: MissionCaseKind) {
  return ({
    customer_cancellation: "Customer cancellation request",
    customer_problem: "Customer reported a problem",
    scout_customer_no_show: "Scout reported a customer no-show",
    scout_safety_concern: "Scout reported a safety concern",
  } satisfies Record<MissionCaseKind, string>)[kind];
}
