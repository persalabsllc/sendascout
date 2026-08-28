import "server-only";

import * as zipcodes from "zipcodes";

function baseZip(value: string | null | undefined) {
  return value?.trim().slice(0, 5) ?? "";
}

export function distanceBetweenZips(first: string | null | undefined, second: string | null | undefined) {
  const firstZip = baseZip(first);
  const secondZip = baseZip(second);
  if (!/^\d{5}$/.test(firstZip) || !/^\d{5}$/.test(secondZip)) return null;
  return zipcodes.distance(firstZip, secondZip);
}

export function isWithinScoutZone(homeZip: string | null | undefined, missionZip: string | null | undefined, radiusMiles: number) {
  const distance = distanceBetweenZips(homeZip, missionZip);
  return distance !== null && distance <= radiusMiles;
}
