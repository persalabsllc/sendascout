export const CUSTOMER_SUPPORT_REASONS = [
  "mission_not_completed",
  "mission_quality",
  "scout_conduct",
  "delivery_problem",
  "billing_question",
  "account_technical",
  "other",
] as const;

export type CustomerSupportReason = typeof CUSTOMER_SUPPORT_REASONS[number];
export type CustomerSupportResolution = "full_refund" | "partial_refund" | "account_credit";

export function customerSupportReasonLabel(reason: CustomerSupportReason) {
  return ({
    mission_not_completed: "Mission was not completed",
    mission_quality: "Mission was completed incorrectly",
    scout_conduct: "Scout conduct or communication",
    delivery_problem: "Delivery problem or damaged item",
    billing_question: "Charge, refund, or credit question",
    account_technical: "Account or technical issue",
    other: "Other customer support request",
  } satisfies Record<CustomerSupportReason, string>)[reason];
}

export function customerSupportResolutionLabel(resolution: CustomerSupportResolution) {
  return ({
    full_refund: "Full refund",
    partial_refund: "Partial refund",
    account_credit: "Send a Scout credit",
  } satisfies Record<CustomerSupportResolution, string>)[resolution];
}

export function validSupportResolutionAmount(
  resolution: CustomerSupportResolution,
  requestedAmountCents: number,
  remainingRefundableCents: number,
  maximumCreditCents: number,
) {
  if (!Number.isSafeInteger(requestedAmountCents) || requestedAmountCents < 0) return null;
  if (resolution === "full_refund") return remainingRefundableCents > 0 ? remainingRefundableCents : null;
  const maximum = resolution === "partial_refund" ? remainingRefundableCents : maximumCreditCents;
  return requestedAmountCents > 0 && requestedAmountCents <= maximum ? requestedAmountCents : null;
}
