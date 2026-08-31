export type LegacyMissionType = "see" | "move" | "meet";

export const MOVE_INCLUDED_ROUTE_MILES = 3;
export const MOVE_CUSTOMER_PER_EXTRA_MILE_CENTS = 175;
export const MOVE_SCOUT_PER_EXTRA_MILE_CENTS = 125;
export const ENHANCED_REPORT_CUSTOMER_CENTS = 900;
export const ENHANCED_REPORT_SCOUT_CENTS = 600;

export type LegacyMissionAmounts = {
  customerPriceCents: number;
  scoutPayoutCents: number;
  platformFeeCents: number;
  additionalRouteMiles: number;
};

/**
 * Pure version of the original See It, Move It, and Meet It pricing rules.
 * Keeping this arithmetic independent from routing providers makes the legacy
 * contract straightforward to regression test as new add-ons are introduced.
 */
export function calculateLegacyMissionAmounts(
  type: LegacyMissionType,
  estimatedRouteMiles: number | null = null,
  largeItem = false,
): LegacyMissionAmounts {
  if (type === "see") return amounts(2900, 1800, 0);
  if (type === "meet") return amounts(2900, 2000, 0);

  const additionalRouteMiles = Math.max(0, (estimatedRouteMiles ?? 0) - MOVE_INCLUDED_ROUTE_MILES);
  const customerPriceCents = 1900
    + additionalRouteMiles * MOVE_CUSTOMER_PER_EXTRA_MILE_CENTS
    + (largeItem ? 1000 : 0);
  const scoutPayoutCents = 1000
    + additionalRouteMiles * MOVE_SCOUT_PER_EXTRA_MILE_CENTS
    + (largeItem ? 800 : 0);
  return amounts(customerPriceCents, scoutPayoutCents, additionalRouteMiles);
}

export function meetPriceForMinutes(minutes: number) {
  const authorizedMinutes = Math.max(60, Math.min(480, Math.ceil(minutes / 15) * 15));
  const additionalQuarters = Math.max(0, Math.ceil((authorizedMinutes - 60) / 15));
  return { customer: 2900 + additionalQuarters * 625, scout: 2000 + additionalQuarters * 450 };
}

function amounts(
  customerPriceCents: number,
  scoutPayoutCents: number,
  additionalRouteMiles: number,
): LegacyMissionAmounts {
  return {
    customerPriceCents,
    scoutPayoutCents,
    platformFeeCents: customerPriceCents - scoutPayoutCents,
    additionalRouteMiles,
  };
}
