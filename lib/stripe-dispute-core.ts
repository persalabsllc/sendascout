export const STRIPE_DISPUTE_CLOSED_STATUSES = ["won", "lost", "prevented", "warning_closed"] as const;
export const STRIPE_DISPUTE_NON_LOSS_STATUSES = ["won", "prevented", "warning_closed"] as const;

export type DisputeAdjustedPaymentStatus = "paid" | "partially_refunded" | "refunded" | "disputed";

export function stripeDisputeIsClosed(status: string) {
  return (STRIPE_DISPUTE_CLOSED_STATUSES as readonly string[]).includes(status);
}

export function stripeDisputeBlocksPayment(status: string) {
  return !(STRIPE_DISPUTE_NON_LOSS_STATUSES as readonly string[]).includes(status);
}

export function paymentStatusAfterDisputes(
  disputeStatuses: readonly string[],
  refundedAmountCents: number,
  amountCents: number,
): DisputeAdjustedPaymentStatus {
  if (disputeStatuses.some(stripeDisputeBlocksPayment)) return "disputed";
  if (refundedAmountCents >= amountCents) return "refunded";
  if (refundedAmountCents > 0) return "partially_refunded";
  return "paid";
}
