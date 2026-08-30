import { DEFAULT_MISSION_TIME_ZONE, normalizeMissionTimeZone } from "./us-time-zones.ts";

export function localDateTimeToUtc(value: string, requestedTimeZone: string) {
  const timeZone = normalizeMissionTimeZone(requestedTimeZone);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) throw new Error("Choose a valid date and time.");

  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
  const second = match[6] ? Number(match[6]) : 0;
  const requestedAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = requestedAsUtc;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedDateParts(new Date(candidate), timeZone);
    const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    candidate += requestedAsUtc - representedAsUtc;
  }

  const result = new Date(candidate);
  const actual = zonedDateParts(result, timeZone);
  if (actual.year !== year || actual.month !== month || actual.day !== day || actual.hour !== hour || actual.minute !== minute) {
    throw new Error("That local time does not exist in the selected time zone. Choose another time.");
  }
  return result;
}

export function formatDateTime(value: Date | string, requestedTimeZone: string) {
  const timeZone = normalizeMissionTimeZone(requestedTimeZone);
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "numeric",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(typeof value === "string" ? new Date(value) : value);
}

export function dateTimeLocalValue(value: Date, requestedTimeZone: string) {
  const parts = zonedDateParts(value, normalizeMissionTimeZone(requestedTimeZone));
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

export function easternLocalDateTimeToUtc(value: string) {
  return localDateTimeToUtc(value, DEFAULT_MISSION_TIME_ZONE);
}

export function formatEasternDateTime(value: Date | string) {
  return formatDateTime(value, DEFAULT_MISSION_TIME_ZONE);
}

function zonedDateParts(value: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
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
