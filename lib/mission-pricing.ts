import "server-only";

import { distanceBetweenZips } from "@/lib/geography";
import { computeDrivingRoute, geocodeAddress, googleMapsConfigured, type Coordinates } from "@/lib/google-maps";
import {
  calculateLegacyMissionAmounts,
  meetPriceForMinutes,
} from "@/lib/mission-pricing-core";

export { meetPriceForMinutes } from "@/lib/mission-pricing-core";

export type MissionPriceQuote = {
  customerPriceCents: number;
  scoutPayoutCents: number;
  platformFeeCents: number;
  estimatedRouteMiles: number | null;
  additionalRouteMiles: number;
  routeDistanceMeters: number | null;
  routeDurationSeconds: number | null;
  routePolyline: string | null;
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
  state: string;
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

export function calculateMissionPrice(type: "see" | "move" | "meet", pickupZip?: string, dropoffZip?: string, largeItem = false): MissionPriceQuote {
  if (type === "see" || type === "meet") {
    const base = calculateLegacyMissionAmounts(type);
    return quote(base.customerPriceCents, base.scoutPayoutCents, null, 0, null, null, null, "fixed", null, null, base.customerPriceCents, base.scoutPayoutCents);
  }

  const zipDistance = distanceBetweenZips(pickupZip, dropoffZip);
  // ZIP centroids provide a conservative draft estimate until live route pricing is connected.
  const estimatedRouteMiles = zipDistance === null ? null : Math.max(0, Math.ceil(zipDistance));
  const base = calculateLegacyMissionAmounts("move", estimatedRouteMiles, largeItem);
  return quote(base.customerPriceCents, base.scoutPayoutCents, estimatedRouteMiles, base.additionalRouteMiles, null, null, null, "zip_estimate", null, null, base.customerPriceCents, base.scoutPayoutCents);
}

export async function calculateMissionQuote(input: MissionQuoteInput): Promise<MissionPriceQuote> {
  if (input.type !== "move") {
    const base = calculateMissionPrice(input.type);
    const coordinates = googleMapsConfigured() ? await geocodeAddress(formatAddress(input.address, input.addressLine2, input.city, input.state, input.zip)) : null;
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
  const base = calculateLegacyMissionAmounts("move", estimatedRouteMiles, input.largeItem);
  return quote(base.customerPriceCents, base.scoutPayoutCents, estimatedRouteMiles, base.additionalRouteMiles, route.distanceMeters, route.durationSeconds, route.encodedPolyline, "google", pickupCoordinates, dropoffCoordinates, base.customerPriceCents, base.scoutPayoutCents);
}

function quote(customerPriceCents: number, scoutPayoutCents: number, estimatedRouteMiles: number | null, additionalRouteMiles: number, routeDistanceMeters: number | null, routeDurationSeconds: number | null, routePolyline: string | null, routeSource: MissionPriceQuote["routeSource"], pickupCoordinates: Coordinates | null, dropoffCoordinates: Coordinates | null, maximumCustomerPriceCents: number, maximumScoutPayoutCents: number): MissionPriceQuote {
  return {
    customerPriceCents,
    scoutPayoutCents,
    platformFeeCents: customerPriceCents - scoutPayoutCents,
    estimatedRouteMiles,
    additionalRouteMiles,
    routeDistanceMeters,
    routeDurationSeconds,
    routePolyline,
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
