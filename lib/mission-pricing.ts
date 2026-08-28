import "server-only";

import { distanceBetweenZips } from "@/lib/geography";

export type MissionPriceQuote = {
  customerPriceCents: number;
  scoutPayoutCents: number;
  platformFeeCents: number;
  estimatedRouteMiles: number | null;
  additionalRouteMiles: number;
};

const MOVE_INCLUDED_ROUTE_MILES = 3;
const MOVE_CUSTOMER_PER_EXTRA_MILE_CENTS = 175;
const MOVE_SCOUT_PER_EXTRA_MILE_CENTS = 125;

export function calculateMissionPrice(type: "see" | "move" | "meet", pickupZip?: string, dropoffZip?: string, largeItem = false): MissionPriceQuote {
  if (type === "see") return quote(2900, 1800, null, 0);
  if (type === "meet") return quote(2900, 2000, null, 0);

  const zipDistance = distanceBetweenZips(pickupZip, dropoffZip);
  // ZIP centroids provide a conservative draft estimate until live route pricing is connected.
  const estimatedRouteMiles = zipDistance === null ? null : Math.max(0, Math.ceil(zipDistance));
  const additionalRouteMiles = Math.max(0, (estimatedRouteMiles ?? 0) - MOVE_INCLUDED_ROUTE_MILES);
  const customer = 1900 + additionalRouteMiles * MOVE_CUSTOMER_PER_EXTRA_MILE_CENTS + (largeItem ? 1000 : 0);
  const scout = 1000 + additionalRouteMiles * MOVE_SCOUT_PER_EXTRA_MILE_CENTS + (largeItem ? 800 : 0);
  return quote(customer, scout, estimatedRouteMiles, additionalRouteMiles);
}

function quote(customerPriceCents: number, scoutPayoutCents: number, estimatedRouteMiles: number | null, additionalRouteMiles: number): MissionPriceQuote {
  return {
    customerPriceCents,
    scoutPayoutCents,
    platformFeeCents: customerPriceCents - scoutPayoutCents,
    estimatedRouteMiles,
    additionalRouteMiles,
  };
}
