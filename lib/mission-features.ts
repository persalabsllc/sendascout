export type FeatureMissionStatus =
  | "draft" | "open" | "claimed" | "en_route" | "onsite"
  | "en_route_pickup" | "at_pickup" | "en_route_dropoff" | "at_dropoff"
  | "submitted" | "completed" | "cancelled" | "disputed";

export type BundleLifecycleStatus =
  | "draft" | "open" | "claimed" | "in_progress"
  | "submitted" | "completed" | "cancelled" | "disputed";

export type MissionPricingLine = {
  customerPriceCents: number;
  scoutPayoutCents: number;
};

export type BundlePricing = {
  listCustomerPriceCents: number;
  bundleDiscountCents: number;
  customerPriceCents: number;
  scoutPayoutCents: number;
  platformFeeCents: number;
};

export function calculateBundlePricing(lines: MissionPricingLine[], requestedDiscountCents = 0): BundlePricing {
  if (!lines.length) throw new Error("A mission bundle must contain at least one mission.");
  const normalized = lines.map((line) => ({
    customerPriceCents: wholeNonnegativeCents(line.customerPriceCents, "Customer price"),
    scoutPayoutCents: wholeNonnegativeCents(line.scoutPayoutCents, "Scout payout"),
  }));
  if (normalized.some((line) => line.scoutPayoutCents > line.customerPriceCents)) {
    throw new Error("A mission price cannot be lower than its Scout payout.");
  }
  const listCustomerPriceCents = normalized.reduce((sum, line) => sum + line.customerPriceCents, 0);
  const scoutPayoutCents = normalized.reduce((sum, line) => sum + line.scoutPayoutCents, 0);
  const requested = wholeNonnegativeCents(requestedDiscountCents, "Bundle discount");
  const bundleDiscountCents = Math.min(requested, listCustomerPriceCents - scoutPayoutCents);
  const customerPriceCents = listCustomerPriceCents - bundleDiscountCents;
  return {
    listCustomerPriceCents,
    bundleDiscountCents,
    customerPriceCents,
    scoutPayoutCents,
    platformFeeCents: customerPriceCents - scoutPayoutCents,
  };
}

export function calculateDiscountedMissionPrice(line: MissionPricingLine, requestedDiscountCents: number) {
  return calculateBundlePricing([line], requestedDiscountCents);
}

export function isPrimaryMissionRow(bundleId: string | null | undefined, bundleSequence: number | null | undefined) {
  return !bundleId || bundleSequence === 1;
}

export function isFinalBundleLeg(bundleId: string | null | undefined, bundleSequence: number | null | undefined, totalLegs: number | null | undefined) {
  if (!bundleId) return true;
  return Number.isInteger(bundleSequence) && Number.isInteger(totalLegs) && bundleSequence === totalLegs && (totalLegs ?? 0) > 0;
}

export function shouldIncrementCompletedMissionCount(bundleId: string | null | undefined, bundleSequence: number | null | undefined, totalLegs: number | null | undefined) {
  return isFinalBundleLeg(bundleId, bundleSequence, totalLegs);
}

export function canActivateBundleLeg(input: {
  activeSequence: number;
  legSequence: number;
  predecessorStatus?: FeatureMissionStatus | null;
}) {
  if (!Number.isInteger(input.activeSequence) || !Number.isInteger(input.legSequence)) return false;
  if (input.activeSequence !== input.legSequence || input.legSequence < 1) return false;
  if (input.legSequence === 1) return true;
  return input.predecessorStatus === "submitted" || input.predecessorStatus === "completed";
}

export function nextBundleProgress(activeSequence: number, totalLegs: number): {
  activeSequence: number;
  status: BundleLifecycleStatus;
} {
  if (!Number.isInteger(activeSequence) || !Number.isInteger(totalLegs) || activeSequence < 1 || totalLegs < 1 || activeSequence > totalLegs) {
    throw new Error("Bundle progress is invalid.");
  }
  if (activeSequence === totalLegs) return { activeSequence, status: "submitted" };
  return { activeSequence: activeSequence + 1, status: "in_progress" };
}

export function bundleStatusForLeg(status: FeatureMissionStatus, finalLeg: boolean): BundleLifecycleStatus {
  if (status === "draft" || status === "open" || status === "claimed" || status === "cancelled" || status === "disputed") return status;
  if (status === "completed") return finalLeg ? "completed" : "in_progress";
  if (status === "submitted") return finalLeg ? "submitted" : "in_progress";
  return "in_progress";
}

export function nextRecurrenceDate(
  current: Date,
  recurrenceRule: string,
  options: { timeZone?: string; anchor?: Date } = {},
) {
  if (Number.isNaN(current.getTime())) throw new Error("The current recurrence date is invalid.");
  if (options.anchor && Number.isNaN(options.anchor.getTime())) throw new Error("The recurrence anchor date is invalid.");
  const fields = new Map(recurrenceRule.toUpperCase().split(";").map((part) => {
    const [key, value] = part.split("=", 2);
    return [key?.trim(), value?.trim()];
  }));
  const frequency = fields.get("FREQ");
  const interval = Number(fields.get("INTERVAL") ?? "1");
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) throw new Error("The recurrence interval is invalid.");
  const timeZone = options.timeZone ?? "America/New_York";
  const currentLocal = zonedDateParts(current, timeZone);
  const anchorLocal = zonedDateParts(options.anchor ?? current, timeZone);
  const next = new Date(Date.UTC(
    currentLocal.year,
    currentLocal.month - 1,
    currentLocal.day,
    currentLocal.hour,
    currentLocal.minute,
    currentLocal.second,
    current.getUTCMilliseconds(),
  ));
  if (frequency === "DAILY") next.setUTCDate(next.getUTCDate() + interval);
  else if (frequency === "WEEKLY") next.setUTCDate(next.getUTCDate() + interval * 7);
  else if (frequency === "MONTHLY") {
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + interval);
    const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(anchorLocal.day, lastDay));
  }
  else throw new Error("Only DAILY, WEEKLY, and MONTHLY recurrence rules are supported.");
  return zonedLocalDateTimeToUtc({
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    hour: next.getUTCHours(),
    minute: next.getUTCMinutes(),
    second: next.getUTCSeconds(),
    millisecond: next.getUTCMilliseconds(),
  }, timeZone);
}

export function recurrenceOccurrenceKey(recurrenceId: string, occurrenceAt: Date) {
  const normalizedId = recurrenceId.trim();
  if (!normalizedId || Number.isNaN(occurrenceAt.getTime())) throw new Error("Recurrence occurrence information is invalid.");
  return `${normalizedId}:${occurrenceAt.toISOString()}`;
}

function wholeNonnegativeCents(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative whole-cent amount.`);
  return value;
}

type ZonedDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function zonedDateParts(value: Date, timeZone: string): ZonedDateParts {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new Error("The recurrence time zone is invalid.");
  }
  const parts = Object.fromEntries(formatter.formatToParts(value).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function zonedLocalDateTimeToUtc(
  requested: ZonedDateParts & { millisecond: number },
  timeZone: string,
) {
  const requestedAsUtc = Date.UTC(
    requested.year,
    requested.month - 1,
    requested.day,
    requested.hour,
    requested.minute,
    requested.second,
    requested.millisecond,
  );
  let candidate = requestedAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const represented = zonedDateParts(new Date(candidate), timeZone);
    const representedAsUtc = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
      represented.second,
      requested.millisecond,
    );
    const correction = requestedAsUtc - representedAsUtc;
    candidate += correction;
    if (correction === 0) break;
  }
  const result = new Date(candidate);
  const actual = zonedDateParts(result, timeZone);
  if (
    actual.year !== requested.year
    || actual.month !== requested.month
    || actual.day !== requested.day
    || actual.hour !== requested.hour
    || actual.minute !== requested.minute
    || actual.second !== requested.second
  ) {
    throw new Error("The next recurrence falls on a local time that does not exist.");
  }
  return result;
}
