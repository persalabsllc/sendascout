export const MEET_TRAVEL_EARLY_MINUTES = 30;
export const MEET_CHECK_IN_EARLY_MINUTES = 5;

export function meetActionOpensAt(scheduledFor: Date | string, action: "en_route" | "onsite") {
  const scheduledMs = new Date(scheduledFor).getTime();
  const earlyMinutes = action === "en_route" ? MEET_TRAVEL_EARLY_MINUTES : MEET_CHECK_IN_EARLY_MINUTES;
  return new Date(scheduledMs - earlyMinutes * 60_000);
}

export function meetActionIsAvailable(scheduledFor: Date | string, action: "en_route" | "onsite", now = new Date()) {
  return now.getTime() >= meetActionOpensAt(scheduledFor, action).getTime();
}
