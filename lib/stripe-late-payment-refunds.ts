import "server-only";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { payments } from "@/db/schema";
import { requestPaymentRefund } from "@/lib/stripe-refunds";

export const LATE_PAYMENT_REFUND_CODE = "late_payment_refund_required";

type LatePaymentRefundState = {
  paymentId: string;
  paymentKind: string;
  hasStripeCharge: boolean;
  targetCents: number;
  succeededCents: number;
  pendingCents: number;
  residualCents: number;
  failedCents: number;
  lateRequestCount: number;
};

export async function refundLatePaymentBestEffort(paymentId: string, source: string) {
  try {
    const result = await refundLatePayment(paymentId);
    if (result && result.succeededCents < result.targetCents) {
      console.info("Late payment refund remains pending", {
        paymentId,
        source,
        targetCents: result.targetCents,
        succeededCents: result.succeededCents,
        pendingCents: result.pendingCents,
        residualCents: result.residualCents,
        failedCents: result.failedCents,
      });
    }
    return result;
  } catch (error) {
    console.error("Late payment refund could not be requested", { paymentId, source, error });
    return null;
  }
}

export async function reconcileLatePaymentRefunds(limit = 25) {
  const boundedLimit = Math.max(1, Math.min(100, Number.isSafeInteger(limit) ? limit : 25));
  const rows = await getDb().select({ id: payments.id }).from(payments).where(and(
    eq(payments.failureCode, LATE_PAYMENT_REFUND_CODE),
    inArray(payments.status, ["paid", "partially_refunded", "disputed"]),
  )).orderBy(asc(payments.updatedAt)).limit(boundedLimit);

  let completed = 0;
  let incomplete = 0;
  for (const row of rows) {
    const result = await refundLatePaymentBestEffort(row.id, "hourly_reconciliation");
    if (result && result.succeededCents >= result.targetCents) completed += 1;
    else incomplete += 1;
  }
  return { found: rows.length, completed, incomplete };
}

async function refundLatePayment(paymentId: string) {
  const state = await readLatePaymentRefundState(paymentId);
  if (!state) return null;
  if (!state.hasStripeCharge) throw new Error("The late payment has not been linked to its Stripe charge.");
  if (state.residualCents <= 0) return state;

  await requestPaymentRefund({
    paymentId: state.paymentId,
    amountCents: state.residualCents,
    idempotencyKey: `late-payment:${state.paymentId}:refund:v2:from-${state.targetCents - state.residualCents}:attempt-${state.lateRequestCount + 1}`,
    reason: `late-payment:${state.paymentKind}`,
  });
  return await readLatePaymentRefundState(paymentId) ?? state;
}

async function readLatePaymentRefundState(paymentId: string): Promise<LatePaymentRefundState | null> {
  const rows = await getDb().execute(sql`
    WITH refund_totals AS MATERIALIZED (
      SELECT payment.id AS payment_id,
        payment.kind AS payment_kind,
        (payment.stripe_charge_id IS NOT NULL) AS has_stripe_charge,
        payment.amount_cents AS target_cents,
        payment.refunded_amount_cents,
        COALESCE(SUM(refund.amount_cents) FILTER (
          WHERE refund.status = 'succeeded'
        ), 0)::integer AS ledger_succeeded_cents,
        COALESCE(SUM(refund.amount_cents) FILTER (
          WHERE refund.status IN ('pending', 'requires_action')
        ), 0)::integer AS ledger_pending_cents,
        COALESCE(SUM(refund.amount_cents) FILTER (
          WHERE refund.status IN ('failed', 'canceled')
            AND refund.reason = ('late-payment:' || payment.kind)
        ), 0)::integer AS late_failed_cents,
        COUNT(refund.id) FILTER (
          WHERE refund.reason = ('late-payment:' || payment.kind)
        )::integer AS late_request_count
      FROM payments AS payment
      LEFT JOIN payment_refunds AS refund ON refund.payment_id = payment.id
      WHERE payment.id = ${paymentId}
        AND payment.failure_code = ${LATE_PAYMENT_REFUND_CODE}
        AND payment.status IN ('paid', 'partially_refunded', 'disputed', 'refunded')
      GROUP BY payment.id
    ), normalized AS MATERIALIZED (
      SELECT refund_totals.*,
        LEAST(
          refund_totals.target_cents,
          GREATEST(refund_totals.refunded_amount_cents, refund_totals.ledger_succeeded_cents)
        )::integer AS succeeded_cents
      FROM refund_totals
    )
    SELECT normalized.payment_id,
      normalized.payment_kind,
      normalized.has_stripe_charge,
      normalized.target_cents,
      normalized.succeeded_cents,
      LEAST(
        GREATEST(normalized.target_cents - normalized.succeeded_cents, 0),
        normalized.ledger_pending_cents
      )::integer AS pending_cents,
      GREATEST(
        normalized.target_cents
          - normalized.succeeded_cents
          - LEAST(
            GREATEST(normalized.target_cents - normalized.succeeded_cents, 0),
            normalized.ledger_pending_cents
          ),
        0
      )::integer AS residual_cents,
      normalized.late_failed_cents AS failed_cents,
      normalized.late_request_count
    FROM normalized
  `) as unknown as Array<{
    payment_id: string;
    payment_kind: string;
    has_stripe_charge: boolean;
    target_cents: number;
    succeeded_cents: number;
    pending_cents: number;
    residual_cents: number;
    failed_cents: number;
    late_request_count: number;
  }>;
  const row = rows[0];
  if (!row) return null;
  return {
    paymentId: row.payment_id,
    paymentKind: row.payment_kind,
    hasStripeCharge: row.has_stripe_charge,
    targetCents: Number(row.target_cents),
    succeededCents: Number(row.succeeded_cents),
    pendingCents: Number(row.pending_cents),
    residualCents: Number(row.residual_cents),
    failedCents: Number(row.failed_cents),
    lateRequestCount: Number(row.late_request_count),
  };
}
