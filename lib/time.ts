const EASTERN_TIME_ZONE = "America/New_York";

const easternPartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: EASTERN_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function easternLocalDateTimeToUtc(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) throw new Error("Choose a valid date and time.");

  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
  const second = match[6] ? Number(match[6]) : 0;
  const requestedAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = requestedAsUtc;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = easternDateParts(new Date(candidate));
    const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    candidate += requestedAsUtc - representedAsUtc;
  }

  const result = new Date(candidate);
  const actual = easternDateParts(result);
  if (actual.year !== year || actual.month !== month || actual.day !== day || actual.hour !== hour || actual.minute !== minute) {
    throw new Error("That local time does not exist in Eastern Time. Choose another time.");
  }
  return result;
}

export function formatEasternDateTime(value: Date | string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_TIME_ZONE,
    month: "numeric",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(typeof value === "string" ? new Date(value) : value);
}

function easternDateParts(value: Date) {
  const parts = Object.fromEntries(easternPartsFormatter.formatToParts(value).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}
