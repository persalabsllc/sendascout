import "server-only";

import { distanceBetweenZips } from "@/lib/geography";
import { computeDrivingRoute, geocodeAddress, googleMapsConfigured, type Coordinates } from "@/lib/google-maps";

export type MissionPriceQuote = {
  customerPriceCents: number;
  scoutPayoutCents: number;
  platformFeeCents: number;
  estimatedRouteMiles: number | null;
  additionalRouteMiles: number;
  routeDistanceMeters: number | null;
  routeDurationSeconds: number | null;
  routeSource: "google" | "zip_estimate" | "fixed";
  pickupCoordinates: Coordinates | null;
  dropoffCoordinates: Coordinates | null;
  maximumCustomerPriceCents: number;
  maximumScoutPayoutCents: number;
};

export type MissionQuoteInput = {
  type: "see" | "move" | "meet";
  address: string;
  addressLine2: string;
  city: string;
  zip: string;
  pickupAddress: string;
  pickupAddressLine2: string;
  pickupCity: string;
  pickupState: string;
  pickupZip: string;
  dropoffAddress: string;
  dropoffAddressLine2: string;
  dropoffCity: string;
  dropoffState: string;
  dropoffZip: string;
  largeItem: boolean;
  meetAuthorizedMinutes: number;
};

const MOVE_INCLUDED_ROUTE_MILES = 3;
const MOVE_CUSTOMER_PER_EXTRA_MILE_CENTS = 175;
const MOVE_SCOUT_PER_EXTRA_MILE_CENTS = 125;

export function calculateMissionPrice(type: "see" | "move" | "meet", pickupZip?: string, dropoffZip?: string, largeItem = false): MissionPriceQuote {
  if (type === "see") return quote(2900, 1800, null, 0, null, null, "fixed", null, null, 2900, 1800);
  if (type === "meet") return quote(2900, 2000, null, 0, null, null, "fixed", null, null, 2900, 2000);

  const zipDistance = distanceBetweenZips(pickupZip, dropoffZip);
  // ZIP centroids provide a conservative draft estimate until live route pricing is connected.
  const estimatedRouteMiles = zipDistance === null ? null : Math.max(0, Math.ceil(zipDistance));
  const additionalRouteMiles = Math.max(0, (estimatedRouteMiles ?? 0) - MOVE_INCLUDED_ROUTE_MILES);
  const customer = 1900 + additionalRouteMiles * MOVE_CUSTOMER_PER_EXTRA_MILE_CENTS + (largeItem ? 1000 : 0);
  const scout = 1000 + additionalRouteMiles * MOVE_SCOUT_PER_EXTRA_MILE_CENTS + (largeItem ? 800 : 0);
  return quote(customer, scout, estimatedRouteMiles, additionalRouteMiles, null, null, "zip_estimate", null, null, customer, scout);
}

export async function calculateMissionQuote(input: MissionQuoteInput): Promise<MissionPriceQuote> {
  if (input.type !== "move") {
    const base = calculateMissionPrice(input.type);
    const coordinates = googleMapsConfigured() ? await geocodeAddress(formatAddress(input.address, input.addressLine2, input.city, "NC", input.zip)) : null;
    if (input.type === "meet") {
      const maximum = meetPriceForMinutes(input.meetAuthorizedMinutes);
      return { ...base, pickupCoordinates: coordinates, maximumCustomerPriceCents: maximum.customer, maximumScoutPayoutCents: maximum.scout };
    }
    return { ...base, pickupCoordinates: coordinates };
  }

  if (!googleMapsConfigured()) return calculateMissionPrice("move", input.pickupZip, input.dropoffZip, input.largeItem);
  const [pickupCoordinates, dropoffCoordinates] = await Promise.all([
    geocodeAddress(formatAddress(input.pickupAddress, input.pickupAddressLine2, input.pickupCity, input.pickupState, input.pickupZip)),
    geocodeAddress(formatAddress(input.dropoffAddress, input.dropoffAddressLine2, input.dropoffCity, input.dropoffState, input.dropoffZip)),
  ]);
  if (!pickupCoordinates || !dropoffCoordinates) throw new Error("Both delivery addresses must be valid.");
  const route = await computeDrivingRoute(pickupCoordinates, dropoffCoordinates);
  const estimatedRouteMiles = Math.max(1, Math.ceil(route.distanceMeters / 1609.344));
  const additionalRouteMiles = Math.max(0, estimatedRouteMiles - MOVE_INCLUDED_ROUTE_MILES);
  const customer = 1900 + additionalRouteMiles * MOVE_CUSTOMER_PER_EXTRA_MILE_CENTS + (input.largeItem ? 1000 : 0);
  const scout = 1000 + additionalRouteMiles * MOVE_SCOUT_PER_EXTRA_MILE_CENTS + (input.largeItem ? 800 : 0);
  return quote(customer, scout, estimatedRouteMiles, additionalRouteMiles, route.distanceMeters, route.durationSeconds, "google", pickupCoordinates, dropoffCoordinates, customer, scout);
}

export function meetPriceForMinutes(minutes: number) {
  const authorizedMinutes = Math.max(60, Math.min(480, Math.ceil(minutes / 15) * 15));
  const additionalQuarters = Math.max(0, Math.ceil((authorizedMinutes - 60) / 15));
  return { customer: 2900 + additionalQuarters * 625, scout: 2000 + additionalQuarters * 450 };
}

function quote(customerPriceCents: number, scoutPayoutCents: number, estimatedRouteMiles: number | null, additionalRouteMiles: number, routeDistanceMeters: number | null, routeDurationSeconds: number | null, routeSource: MissionPriceQuote["routeSource"], pickupCoordinates: Coordinates | null, dropoffCoordinates: Coordinates | null, maximumCustomerPriceCents: number, maximumScoutPayoutCents: number): MissionPriceQuote {
  return {
    customerPriceCents,
    scoutPayoutCents,
    platformFeeCents: customerPriceCents - scoutPayoutCents,
    estimatedRouteMiles,
    additionalRouteMiles,
    routeDistanceMeters,
    routeDurationSeconds,
    routeSource,
    pickupCoordinates,
    dropoffCoordinates,
    maximumCustomerPriceCents,
    maximumScoutPayoutCents,
  };
}

function formatAddress(line1: string, line2: string, city: string, state: string, zip: string) {
  return [line1, line2, city, state, zip].map((value) => value.trim()).filter(Boolean).join(", ");
}
