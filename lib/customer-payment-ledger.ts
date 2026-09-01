type CustomerPaymentLedgerEntry = {
  status: string;
  failureCode: string | null;
  stripePaymentIntentId: string | null;
  paidAt: Date | null;
  stripeChargeId: string | null;
  refundedAmountCents: number;
};

const neverCollectedStatuses = new Set([
  "pending",
  "requires_action",
  "failed",
  "canceled",
]);

export function customerPaymentEntryIsVisible(
  missionStatus: string,
  payment: CustomerPaymentLedgerEntry,
) {
  if (missionStatus !== "cancelled") return true;
  if (
    payment.status === "processing"
    && payment.failureCode === "checkout_creating"
    && !payment.stripePaymentIntentId
    && !payment.paidAt
    && !payment.stripeChargeId
    && payment.refundedAmountCents === 0
  ) return false;
  if (!neverCollectedStatuses.has(payment.status)) return true;

  return Boolean(
    payment.paidAt
      || payment.stripeChargeId
      || payment.refundedAmountCents > 0,
  );
}
