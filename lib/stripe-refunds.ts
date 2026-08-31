import "server-only";

import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { getDb } from "@/db";
import {
  customerSupportTickets,
  missionCases,
  missions,
  payments,
  paymentRefunds,
  paymentTransferReversals,
  paymentTransfers,
} from "@/db/schema";
import { reconcilePaymentTransferIdentity } from "@/lib/stripe-settlement";
import { getStripe, getStripeLivemode, stripeErrorDetails, stripeObjectId } from "@/lib/stripe";

type RefundRow = typeof paymentRefunds.$inferSelect;
type ReversalRow = typeof paymentTransferReversals.$inferSelect;
type TransferRow = typeof paymentTransfers.$inferSelect;
type RefundStatus = RefundRow["status"];

export type MissionRefundRequest = {
  missionId: string;
  amountCents: number;
  idempotencyKey: string;
  reason?: string;
  missionCaseId?: string | null;
  /** Transfer reversals are never inferred from a refund or dispute. The caller must opt in. */
  reverseScoutTransfer?: boolean;
  /** Defaults to the refund amount and is capped to the remaining intended Scout transfer. */
  scoutReversalAmountCents?: number;
  /** Reserve the exact charge allocation without contacting Stripe yet. */
  deferProcessing?: boolean;
};

export type PaymentRefundRequest = Omit<MissionRefundRequest, "missionId"> & {
  /** The refund is allocated only to this payment's Stripe charge and never spills to another charge. */
  paymentId: string;
};

export type MissionRefundResult = {
  refunds: RefundRow[];
  refundRequestedCents: number;
  refundSucceededCents: number;
  refundPendingCents: number;
  refundFailedCents: number;
  reversals: ReversalRow[];
  reversalRequestedCents: number;
  reversalAllocatedCents: number;
  reversalSucceededCents: number;
  reversalPendingCents: number;
  reversalFailedCents: number;
};

export type PaymentRefundResult = MissionRefundResult;

export type RefundReconciliationResult = {
  found: number;
  completed: number;
  incomplete: number;
  errors: number;
};

export function missionCaseRefundReason(missionCaseId: string) {
  return `mission-case:${missionCaseId}`;
}

const REFUND_ALLOCATION_SQL = `
  WITH existing_request AS MATERIALIZED (
    SELECT refund.id
    FROM payment_refunds AS refund
    WHERE refund.idempotency_key LIKE $3
  ), locked_payments AS MATERIALIZED (
    SELECT candidate.id,
           candidate.amount_cents,
           candidate.refunded_amount_cents,
           candidate.currency,
           candidate.paid_at,
           candidate.created_at
    FROM payments AS candidate
    WHERE candidate.mission_id = ANY($1::uuid[])
      AND candidate.customer_id = $2::uuid
      AND candidate.stripe_charge_id IS NOT NULL
      AND candidate.livemode = $8::boolean
      AND candidate.kind NOT IN ('tip', 'duplicate')
      AND candidate.status IN ('paid', 'partially_refunded', 'disputed')
      AND NOT EXISTS (
        SELECT 1
        FROM payment_transfers AS committed_transfer
        WHERE committed_transfer.payment_id = candidate.id
          AND committed_transfer.status = 'processing'
      )
    ORDER BY COALESCE(candidate.paid_at, candidate.created_at), candidate.created_at, candidate.id
    FOR UPDATE OF candidate
  ), capacity AS MATERIALIZED (
    SELECT locked.id,
           locked.currency,
           GREATEST(
             0,
             locked.amount_cents - (
               GREATEST(
                 locked.refunded_amount_cents,
                 COALESCE((
                   SELECT SUM(refund.amount_cents)
                   FROM payment_refunds AS refund
                   WHERE refund.payment_id = locked.id
                     AND refund.status = 'succeeded'
                 ), 0)
               )
               + COALESCE((
                 SELECT SUM(refund.amount_cents)
                 FROM payment_refunds AS refund
                 WHERE refund.payment_id = locked.id
                   AND refund.status IN ('pending', 'requires_action')
               ), 0)
             )
           )::integer AS remaining_cents,
           COALESCE(locked.paid_at, locked.created_at) AS allocation_order,
           locked.created_at
    FROM locked_payments AS locked
  ), ordered_capacity AS MATERIALIZED (
    SELECT capacity.*,
           COALESCE(
             SUM(capacity.remaining_cents) OVER (
               ORDER BY capacity.allocation_order, capacity.created_at, capacity.id
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
             ),
             0
           ) AS previously_available_cents
    FROM capacity
  ), request_capacity AS MATERIALIZED (
    SELECT COALESCE(SUM(capacity.remaining_cents), 0) AS available_cents
    FROM capacity
  ), allocations AS MATERIALIZED (
    SELECT ordered.id AS payment_id,
           ordered.currency,
           LEAST(
             ordered.remaining_cents,
             GREATEST($4::bigint - ordered.previously_available_cents, 0)
           )::integer AS amount_cents
    FROM ordered_capacity AS ordered
  ), inserted AS (
    INSERT INTO payment_refunds (
      payment_id,
      mission_case_id,
      amount_cents,
      currency,
      reason,
      idempotency_key,
      status,
      updated_at
    )
    SELECT allocation.payment_id,
           $5::uuid,
           allocation.amount_cents,
           allocation.currency,
           $6,
           $7 || ':' || allocation.payment_id::text,
           'pending',
           now()
    FROM allocations AS allocation
    WHERE allocation.amount_cents > 0
      AND NOT EXISTS (SELECT 1 FROM existing_request)
      AND (SELECT available_cents FROM request_capacity) >= $4::bigint
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id
  )
  SELECT (SELECT available_cents FROM request_capacity) AS available_cents,
         (SELECT COUNT(*)::integer FROM existing_request) AS existing_count,
         (SELECT COUNT(*)::integer FROM inserted) AS inserted_count
`;

const PAYMENT_REFUND_ALLOCATION_SQL = `
  WITH existing_request AS MATERIALIZED (
    SELECT refund.id
    FROM payment_refunds AS refund
    WHERE refund.idempotency_key LIKE $2
  ), locked_payment AS MATERIALIZED (
    SELECT candidate.id,
           candidate.amount_cents,
           candidate.refunded_amount_cents,
           candidate.currency
    FROM payments AS candidate
    WHERE candidate.id = $1::uuid
      AND candidate.stripe_charge_id IS NOT NULL
      AND candidate.legacy_stripe_transfer_id IS NULL
      AND candidate.status IN ('paid', 'partially_refunded', 'disputed')
      AND NOT EXISTS (
        SELECT 1
        FROM payment_transfers AS committed_transfer
        WHERE committed_transfer.payment_id = candidate.id
          AND committed_transfer.status = 'processing'
      )
    FOR UPDATE OF candidate
  ), capacity AS MATERIALIZED (
    SELECT locked.id,
           locked.currency,
           GREATEST(
             0,
             locked.amount_cents - (
               GREATEST(
                 locked.refunded_amount_cents,
                 COALESCE((
                   SELECT SUM(refund.amount_cents)
                   FROM payment_refunds AS refund
                   WHERE refund.payment_id = locked.id
                     AND refund.status = 'succeeded'
                 ), 0)
               )
               + COALESCE((
                 SELECT SUM(refund.amount_cents)
                 FROM payment_refunds AS refund
                 WHERE refund.payment_id = locked.id
                   AND refund.status IN ('pending', 'requires_action')
               ), 0)
             )
           )::integer AS remaining_cents
    FROM locked_payment AS locked
  ), inserted AS (
    INSERT INTO payment_refunds (
      payment_id,
      mission_case_id,
      amount_cents,
      currency,
      reason,
      idempotency_key,
      status,
      updated_at
    )
    SELECT capacity.id,
           $4::uuid,
           $3::integer,
           capacity.currency,
           $5,
           $6 || ':' || capacity.id::text,
           'pending',
           now()
    FROM capacity
    WHERE capacity.remaining_cents >= $3::integer
      AND NOT EXISTS (SELECT 1 FROM existing_request)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id
  )
  SELECT COALESCE((SELECT remaining_cents FROM capacity), 0)::integer AS available_cents,
         (SELECT COUNT(*)::integer FROM existing_request) AS existing_count,
         (SELECT COUNT(*)::integer FROM inserted) AS inserted_count
`;

const REVERSAL_ALLOCATION_SQL = `
  WITH existing_request AS MATERIALIZED (
    SELECT reversal.id
    FROM payment_transfer_reversals AS reversal
    WHERE reversal.idempotency_key LIKE $2
  ), locked_transfers AS MATERIALIZED (
    SELECT transfer.id,
           transfer.amount_cents,
           transfer.reversed_amount_cents,
           transfer.created_at
    FROM payment_transfers AS transfer
    INNER JOIN payments AS payment ON payment.id = transfer.payment_id
    WHERE payment.mission_id = ANY($1::uuid[])
      AND (
        ($5::uuid IS NULL AND payment.kind NOT IN ('tip', 'duplicate'))
        OR payment.id = $5::uuid
      )
      AND transfer.status IN ('pending', 'processing', 'succeeded', 'partially_reversed', 'failed')
    ORDER BY transfer.created_at, transfer.id
    FOR UPDATE OF transfer
  ), capacity AS MATERIALIZED (
    SELECT locked.id,
           GREATEST(
             0,
             locked.amount_cents - (
               GREATEST(
                 locked.reversed_amount_cents,
                 COALESCE((
                   SELECT SUM(reversal.amount_cents)
                   FROM payment_transfer_reversals AS reversal
                   WHERE reversal.transfer_id = locked.id
                     AND reversal.status = 'succeeded'
                 ), 0)
               )
               + COALESCE((
                 SELECT SUM(reversal.amount_cents)
                 FROM payment_transfer_reversals AS reversal
                 WHERE reversal.transfer_id = locked.id
                   AND reversal.status IN ('pending', 'requires_action')
               ), 0)
             )
           )::integer AS remaining_cents,
           locked.created_at
    FROM locked_transfers AS locked
  ), request_capacity AS MATERIALIZED (
    SELECT COALESCE(SUM(capacity.remaining_cents), 0) AS available_cents
    FROM capacity
  ), effective_request AS MATERIALIZED (
    SELECT LEAST($3::bigint, available_cents) AS amount_cents
    FROM request_capacity
  ), ordered_capacity AS MATERIALIZED (
    SELECT capacity.*,
           COALESCE(
             SUM(capacity.remaining_cents) OVER (
               ORDER BY capacity.created_at, capacity.id
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
             ),
             0
           ) AS previously_available_cents
    FROM capacity
  ), allocations AS MATERIALIZED (
    SELECT ordered.id AS transfer_id,
           LEAST(
             ordered.remaining_cents,
             GREATEST((SELECT amount_cents FROM effective_request) - ordered.previously_available_cents, 0)
           )::integer AS amount_cents
    FROM ordered_capacity AS ordered
  ), inserted AS (
    INSERT INTO payment_transfer_reversals (
      transfer_id,
      amount_cents,
      idempotency_key,
      status,
      updated_at
    )
    SELECT allocation.transfer_id,
           allocation.amount_cents,
           $4 || ':' || allocation.transfer_id::text,
           'pending',
           now()
    FROM allocations AS allocation
    WHERE allocation.amount_cents > 0
      AND NOT EXISTS (SELECT 1 FROM existing_request)
      AND EXISTS (
        SELECT 1
        FROM payment_refunds AS policy_refund
        WHERE policy_refund.idempotency_key LIKE $6
      )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id
  )
  SELECT (SELECT available_cents FROM request_capacity) AS available_cents,
         (SELECT amount_cents FROM effective_request) AS allocated_cents,
         (SELECT COUNT(*)::integer FROM existing_request) AS existing_count,
         (SELECT COUNT(*)::integer FROM inserted) AS inserted_count
`;

export async function requestMissionRefund(input: MissionRefundRequest): Promise<MissionRefundResult> {
  const amountCents = positiveCents(input.amountCents, "Refund amount");
  const requestKey = cleanRequestKey(input.idempotencyKey);
  const reason = cleanReason(input.reason);
  if (!input.reverseScoutTransfer && input.scoutReversalAmountCents !== undefined) {
    throw new Error("A Scout reversal amount requires reverseScoutTransfer to be explicitly enabled.");
  }
  const desiredReversalCents = input.reverseScoutTransfer
    ? positiveCents(input.scoutReversalAmountCents ?? amountCents, "Scout reversal amount")
    : 0;
  if (desiredReversalCents > amountCents) {
    throw new Error("The Scout reversal amount cannot exceed the customer refund amount.");
  }
  const scope = await missionScope(input.missionId, input.missionCaseId ?? null);
  if (input.reverseScoutTransfer && await hasLegacyTransfer(scope.missionIds)) {
    throw new Error("This mission has a legacy Stripe transfer that requires manual reconciliation before reversal.");
  }
  const prefixes = requestPrefixes(
    requestKey,
    Boolean(input.reverseScoutTransfer),
    desiredReversalCents,
    { kind: "mission" },
  );
  const allocation = await allocateRefunds({
    missionIds: scope.missionIds,
    customerId: scope.customerId,
    amountCents,
    missionCaseId: input.missionCaseId ?? null,
    reason,
    existingPrefix: prefixes.refundBase,
    insertPrefix: prefixes.refund,
    reversal: input.reverseScoutTransfer ? {
      amountCents: desiredReversalCents,
      existingPrefix: prefixes.reversalBase,
      insertPrefix: prefixes.reversal,
      refundPolicyPrefix: prefixes.refund,
    } : null,
  });
  let refunds = await refundRowsForPrefix(prefixes.refundBase);
  if (!refunds.length) {
    throw new Error(`The requested refund exceeds the remaining refundable balance of ${money(allocation.availableCents)}.`);
  }
  await validateRefundReplay(
    refunds,
    scope.missionIds,
    amountCents,
    input.missionCaseId ?? null,
    reason,
    prefixes.refund,
    false,
  );

  let reversals: ReversalRow[] = [];
  if (input.reverseScoutTransfer) {
    reversals = await reversalRowsForPrefix(prefixes.reversalBase);
    validateReversalReplay(reversals, prefixes.reversal);
    await assertReversalsInMissionScope(reversals, scope.missionIds, false);
  }

  if (!input.deferProcessing) {
    for (const refund of refunds) await processPaymentRefund(refund.id);
  }
  refunds = await refundRowsForPrefix(prefixes.refundBase);

  // A reversal intent is durable up front, but it only reaches Stripe after every
  // refund in this request succeeds. Failed/canceled refunds cancel the intent.
  for (const reversal of reversals) await processPaymentTransferReversal(reversal.id);
  reversals = input.reverseScoutTransfer ? await reversalRowsForPrefix(prefixes.reversalBase) : [];

  return {
    refunds,
    refundRequestedCents: refunds.reduce((sum, refund) => sum + refund.amountCents, 0),
    refundSucceededCents: ledgerAmount(refunds, ["succeeded"]),
    refundPendingCents: ledgerAmount(refunds, ["pending", "requires_action"]),
    refundFailedCents: ledgerAmount(refunds, ["failed", "canceled"]),
    reversals,
    reversalRequestedCents: desiredReversalCents,
    reversalAllocatedCents: reversals.reduce((sum, reversal) => sum + reversal.amountCents, 0),
    reversalSucceededCents: ledgerAmount(reversals, ["succeeded"]),
    reversalPendingCents: ledgerAmount(reversals, ["pending", "requires_action"]),
    reversalFailedCents: ledgerAmount(reversals, ["failed", "canceled"]),
  };
}

export async function requestPaymentRefund(input: PaymentRefundRequest): Promise<PaymentRefundResult> {
  const amountCents = positiveCents(input.amountCents, "Refund amount");
  const requestKey = cleanRequestKey(input.idempotencyKey);
  const reason = cleanReason(input.reason);
  if (!input.reverseScoutTransfer && input.scoutReversalAmountCents !== undefined) {
    throw new Error("A Scout reversal amount requires reverseScoutTransfer to be explicitly enabled.");
  }
  const desiredReversalCents = input.reverseScoutTransfer
    ? positiveCents(input.scoutReversalAmountCents ?? amountCents, "Scout reversal amount")
    : 0;
  if (desiredReversalCents > amountCents) {
    throw new Error("The Scout reversal amount cannot exceed the customer refund amount.");
  }
  const scope = await paymentRefundScope(input.paymentId, input.missionCaseId ?? null);
  if (await hasLegacyTransfer(scope.missionIds)) {
    throw new Error("This payment belongs to a legacy Stripe transfer scope that requires manual reconciliation.");
  }
  const prefixes = requestPrefixes(
    requestKey,
    Boolean(input.reverseScoutTransfer),
    desiredReversalCents,
    { kind: "payment", paymentId: input.paymentId },
  );
  const allocation = await allocatePaymentRefund({
    paymentId: input.paymentId,
    missionIds: scope.missionIds,
    amountCents,
    missionCaseId: input.missionCaseId ?? null,
    reason,
    existingPrefix: prefixes.refundBase,
    insertPrefix: prefixes.refund,
    reversal: input.reverseScoutTransfer ? {
      amountCents: desiredReversalCents,
      existingPrefix: prefixes.reversalBase,
      insertPrefix: prefixes.reversal,
      refundPolicyPrefix: prefixes.refund,
    } : null,
  });
  let refunds = await refundRowsForPrefix(prefixes.refundBase);
  if (!refunds.length) {
    throw new Error(`The requested refund exceeds this charge's remaining refundable balance of ${money(allocation.availableCents)}.`);
  }
  await validateRefundReplay(
    refunds,
    scope.missionIds,
    amountCents,
    input.missionCaseId ?? null,
    reason,
    prefixes.refund,
    true,
  );
  if (refunds.some((refund) => refund.paymentId !== input.paymentId)) {
    throw new Error("This refund idempotency key was already used for a different payment charge.");
  }

  let reversals: ReversalRow[] = [];
  if (input.reverseScoutTransfer) {
    reversals = await reversalRowsForPrefix(prefixes.reversalBase);
    validateReversalReplay(reversals, prefixes.reversal);
    await assertReversalsForPayment(reversals, input.paymentId);
  }

  if (!input.deferProcessing) {
    for (const refund of refunds) await processPaymentRefund(refund.id);
  }
  refunds = await refundRowsForPrefix(prefixes.refundBase);
  for (const reversal of reversals) await processPaymentTransferReversal(reversal.id);
  reversals = input.reverseScoutTransfer ? await reversalRowsForPrefix(prefixes.reversalBase) : [];

  return {
    refunds,
    refundRequestedCents: refunds.reduce((sum, refund) => sum + refund.amountCents, 0),
    refundSucceededCents: ledgerAmount(refunds, ["succeeded"]),
    refundPendingCents: ledgerAmount(refunds, ["pending", "requires_action"]),
    refundFailedCents: ledgerAmount(refunds, ["failed", "canceled"]),
    reversals,
    reversalRequestedCents: desiredReversalCents,
    reversalAllocatedCents: reversals.reduce((sum, reversal) => sum + reversal.amountCents, 0),
    reversalSucceededCents: ledgerAmount(reversals, ["succeeded"]),
    reversalPendingCents: ledgerAmount(reversals, ["pending", "requires_action"]),
    reversalFailedCents: ledgerAmount(reversals, ["failed", "canceled"]),
  };
}

export async function reconcileMissionCaseRefunds(limit = 25): Promise<RefundReconciliationResult> {
  const rows = await getDb().select({
    id: missionCases.id,
    missionId: missionCases.missionId,
    refundAmountCents: missionCases.refundAmountCents,
  }).from(missionCases).where(and(
    eq(missionCases.status, "resolved"),
    sql`${missionCases.refundAmountCents} > 0`,
    sql`COALESCE((
      SELECT SUM(refund.amount_cents)
      FROM payment_refunds AS refund
      INNER JOIN payments AS refunded_payment ON refunded_payment.id = refund.payment_id
      WHERE refund.mission_case_id = ${missionCases.id}
        AND refunded_payment.kind NOT IN ('tip', 'duplicate')
        AND refund.status = 'succeeded'
    ), 0) < ${missionCases.refundAmountCents}`,
    sql`NOT EXISTS (
      SELECT 1
      FROM payment_refunds AS terminal_refund
      INNER JOIN payments AS refunded_payment ON refunded_payment.id = terminal_refund.payment_id
      WHERE terminal_refund.mission_case_id = ${missionCases.id}
        AND refunded_payment.kind NOT IN ('tip', 'duplicate')
        AND terminal_refund.status IN ('failed', 'canceled')
    )`,
  )).orderBy(asc(missionCases.resolvedAt), asc(missionCases.createdAt)).limit(boundedLimit(limit));

  let completed = 0;
  let incomplete = 0;
  let errors = 0;
  for (const missionCase of rows) {
    try {
      const result = await requestMissionRefund({
        missionId: missionCase.missionId,
        amountCents: missionCase.refundAmountCents,
        idempotencyKey: `mission-case:${missionCase.id}:refund:v1`,
        missionCaseId: missionCase.id,
        reason: missionCaseRefundReason(missionCase.id),
      });
      if (result.refundSucceededCents >= missionCase.refundAmountCents) completed += 1;
      else incomplete += 1;
    } catch (error) {
      errors += 1;
      console.error("Mission case refund reconciliation failed", {
        caseId: missionCase.id,
        error: safeErrorMessage(error),
      });
    }
  }
  return { found: rows.length, completed, incomplete, errors };
}

export async function reconcileApprovedSupportRefunds(limit = 25): Promise<RefundReconciliationResult> {
  const rows = await getDb().select({
    id: customerSupportTickets.id,
    missionId: customerSupportTickets.missionId,
    refundAmountCents: customerSupportTickets.resolutionAmountCents,
  }).from(customerSupportTickets).where(and(
    eq(customerSupportTickets.status, "closed"),
    eq(customerSupportTickets.customerDecision, "approved"),
    inArray(customerSupportTickets.resolutionType, ["full_refund", "partial_refund"]),
    sql`${customerSupportTickets.missionId} IS NOT NULL`,
    sql`${customerSupportTickets.resolutionAmountCents} > 0`,
    sql`COALESCE((
      SELECT SUM(refund.amount_cents)
      FROM payment_refunds AS refund
      INNER JOIN payments AS refunded_payment ON refunded_payment.id = refund.payment_id
      WHERE refund.reason = ('support-ticket:' || ${customerSupportTickets.id}::text)
        AND refunded_payment.kind NOT IN ('tip', 'duplicate')
        AND refund.status = 'succeeded'
    ), 0) < ${customerSupportTickets.resolutionAmountCents}`,
    sql`NOT EXISTS (
      SELECT 1
      FROM payment_refunds AS terminal_refund
      INNER JOIN payments AS refunded_payment ON refunded_payment.id = terminal_refund.payment_id
      WHERE terminal_refund.reason = ('support-ticket:' || ${customerSupportTickets.id}::text)
        AND refunded_payment.kind NOT IN ('tip', 'duplicate')
        AND terminal_refund.status IN ('failed', 'canceled')
    )`,
  )).orderBy(asc(customerSupportTickets.closedAt), asc(customerSupportTickets.createdAt))
    .limit(boundedLimit(limit));

  let completed = 0;
  let incomplete = 0;
  let errors = 0;
  for (const ticket of rows) {
    if (!ticket.missionId) {
      errors += 1;
      continue;
    }
    try {
      const result = await requestMissionRefund({
        missionId: ticket.missionId,
        amountCents: ticket.refundAmountCents,
        idempotencyKey: `support-ticket:${ticket.id}:refund:v1`,
        reason: `support-ticket:${ticket.id}`,
      });
      if (result.refundSucceededCents >= ticket.refundAmountCents) completed += 1;
      else incomplete += 1;
    } catch (error) {
      errors += 1;
      console.error("Approved support refund reconciliation failed", {
        ticketId: ticket.id,
        error: safeErrorMessage(error),
      });
    }
  }
  return { found: rows.length, completed, incomplete, errors };
}

export async function processPendingPaymentRefunds(limit = 25) {
  const rows = await getDb().select({ id: paymentRefunds.id }).from(paymentRefunds)
    .innerJoin(payments, eq(payments.id, paymentRefunds.paymentId))
    .where(or(
      and(
        inArray(paymentRefunds.status, ["pending", "requires_action"]),
        or(
          and(
            isNull(paymentRefunds.missionCaseId),
            sql`${paymentRefunds.reason} NOT LIKE 'mission-case:%'`,
          ),
          like(paymentRefunds.reason, "support-ticket:%"),
          sql`EXISTS (
            SELECT 1 FROM mission_cases AS authorized_case
            WHERE authorized_case.id = ${paymentRefunds.missionCaseId}
              AND authorized_case.status = 'resolved'
          )`,
        ),
      ),
      and(
        eq(paymentRefunds.status, "succeeded"),
        sql`${payments.refundedAmountCents} < (
          SELECT COALESCE(SUM(succeeded.amount_cents), 0)
          FROM payment_refunds AS succeeded
          WHERE succeeded.payment_id = ${payments.id}
            AND succeeded.status = 'succeeded'
        )`,
      ),
    ))
    .orderBy(asc(paymentRefunds.updatedAt))
    .limit(boundedLimit(limit));
  let processed = 0;
  for (const row of rows) {
    try {
      if (await processPaymentRefund(row.id)) processed += 1;
    } catch (error) {
      console.error("Refund reconciliation row failed", { refundId: row.id, error: safeErrorMessage(error) });
    }
  }
  return { found: rows.length, processed };
}

export async function processPaymentRefund(refundRowId: string) {
  const db = getDb();
  const [record] = await db.select({ refund: paymentRefunds, payment: payments })
    .from(paymentRefunds)
    .innerJoin(payments, eq(payments.id, paymentRefunds.paymentId))
    .where(eq(paymentRefunds.id, refundRowId))
    .limit(1);
  if (!record) throw new Error("Refund ledger entry not found.");
  if (record.refund.status === "succeeded") {
    await syncRefundedPayment(record.payment.id);
    return true;
  }
  if (["failed", "canceled"].includes(record.refund.status)) return false;
  if (!record.payment.stripeChargeId) throw new Error("The payment does not have a Stripe charge to refund.");
  if (record.payment.livemode === null) {
    throw new Error("The payment Stripe mode must be reconciled before refunding this legacy charge.");
  }
  if (record.payment.livemode !== getStripeLivemode()) {
    throw new Error("The refund belongs to a different Stripe mode.");
  }

  let stripeRefund: Stripe.Refund;
  try {
    stripeRefund = record.refund.stripeRefundId
      ? await getStripe().refunds.retrieve(record.refund.stripeRefundId)
      : await findStripeRefund(record.refund, record.payment.stripeChargeId)
        ?? await getStripe().refunds.create({
            charge: record.payment.stripeChargeId,
            amount: record.refund.amountCents,
            reason: stripeRefundReason(record.refund.reason),
            metadata: {
              sendascout_refund_id: record.refund.id,
              sendascout_refund_key: record.refund.idempotencyKey,
              sendascout_payment_id: record.payment.id,
              sendascout_mission_id: record.payment.missionId,
              sendascout_mission_case_id: record.refund.missionCaseId ?? "",
              sendascout_reason: record.refund.reason.slice(0, 500),
            },
          }, { idempotencyKey: record.refund.idempotencyKey });
  } catch (error) {
    await recordRefundFailure(record.refund.id, error);
    return false;
  }

  if (stripeObjectId(stripeRefund.charge) !== record.payment.stripeChargeId) {
    throw new Error("Stripe returned a refund for a different charge.");
  }
  if (stripeRefund.amount !== record.refund.amountCents || stripeRefund.currency !== record.refund.currency) {
    throw new Error("Stripe returned a refund amount or currency that does not match the ledger.");
  }
  const status = stripeRefundStatus(stripeRefund.status);
  const now = new Date();
  const mutableStatus = status === "succeeded"
    ? sql`${paymentRefunds.status} NOT IN ('succeeded', 'canceled')`
    : inArray(paymentRefunds.status, ["pending", "requires_action"]);
  const [saved] = await db.update(paymentRefunds).set({
    stripeRefundId: stripeRefund.id,
    status,
    failureCode: stripeRefund.failure_reason ?? null,
    failureMessage: refundFailureMessage(stripeRefund),
    refundedAt: status === "succeeded" ? now : null,
    updatedAt: now,
  }).where(and(
    eq(paymentRefunds.id, record.refund.id),
    or(isNull(paymentRefunds.stripeRefundId), eq(paymentRefunds.stripeRefundId, stripeRefund.id)),
    mutableStatus,
  )).returning({ id: paymentRefunds.id });
  if (!saved) {
    const [current] = await db.select().from(paymentRefunds).where(eq(paymentRefunds.id, record.refund.id)).limit(1);
    if (current?.status === "succeeded" && current.stripeRefundId === stripeRefund.id) {
      await syncRefundedPayment(record.payment.id);
      return true;
    }
    if (current?.status === "canceled") return false;
    throw new Error("The refund ledger was linked to a different Stripe refund.");
  }

  if (status === "succeeded") await syncRefundedPayment(record.payment.id);
  return status === "succeeded";
}

export async function processPendingPaymentTransferReversals(limit = 25) {
  await reconcileMissingPaymentTransferReversals(limit);
  const rows = await getDb().select({ id: paymentTransferReversals.id }).from(paymentTransferReversals)
    .innerJoin(paymentTransfers, eq(paymentTransfers.id, paymentTransferReversals.transferId))
    .where(or(
      eq(paymentTransferReversals.status, "pending"),
      and(
        eq(paymentTransferReversals.status, "succeeded"),
        sql`${paymentTransfers.reversedAmountCents} < (
          SELECT COALESCE(SUM(succeeded.amount_cents), 0)
          FROM payment_transfer_reversals AS succeeded
          WHERE succeeded.transfer_id = ${paymentTransfers.id}
            AND succeeded.status = 'succeeded'
        )`,
      ),
    ))
    .orderBy(asc(paymentTransferReversals.updatedAt))
    .limit(boundedLimit(limit));
  let processed = 0;
  for (const row of rows) {
    try {
      if (await processPaymentTransferReversal(row.id)) processed += 1;
    } catch (error) {
      console.error("Transfer reversal reconciliation row failed", { reversalId: row.id, error: safeErrorMessage(error) });
    }
  }
  return { found: rows.length, processed };
}

export async function reconcileMissingPaymentTransferReversals(limit = 25) {
  const rows = await getDb().select({
    id: paymentRefunds.id,
    paymentId: paymentRefunds.paymentId,
    idempotencyKey: paymentRefunds.idempotencyKey,
  }).from(paymentRefunds).where(and(
    eq(paymentRefunds.status, "succeeded"),
    sql`${paymentRefunds.idempotencyKey} ~ '^refund:v1:[a-f0-9]{32}:(mission|payment_[0-9a-f-]{36}):reverse_[0-9]+:[0-9a-f-]{36}$'`,
    sql`NOT EXISTS (
      SELECT 1
      FROM payment_transfer_reversals AS existing_reversal
      WHERE existing_reversal.idempotency_key LIKE (
        'reversal:v1:' || SUBSTRING(${paymentRefunds.idempotencyKey} FROM 11 FOR 32) || ':%'
      )
    )`,
  )).orderBy(asc(paymentRefunds.updatedAt)).limit(boundedLimit(limit));

  let allocated = 0;
  let errors = 0;
  for (const refund of rows) {
    try {
      if (await ensureMissingReversalIntent(refund)) allocated += 1;
    } catch (error) {
      errors += 1;
      console.error("Missing transfer reversal reconciliation failed", {
        refundId: refund.id,
        error: safeErrorMessage(error),
      });
    } finally {
      await getDb().update(paymentRefunds).set({ updatedAt: new Date() })
        .where(eq(paymentRefunds.id, refund.id));
    }
  }
  return { found: rows.length, allocated, errors };
}

export async function processPaymentTransferReversal(reversalRowId: string) {
  const db = getDb();
  const [record] = await db.select({ reversal: paymentTransferReversals, transfer: paymentTransfers, payment: payments })
    .from(paymentTransferReversals)
    .innerJoin(paymentTransfers, eq(paymentTransfers.id, paymentTransferReversals.transferId))
    .innerJoin(payments, eq(payments.id, paymentTransfers.paymentId))
    .where(eq(paymentTransferReversals.id, reversalRowId))
    .limit(1);
  if (!record) throw new Error("Transfer reversal ledger entry not found.");

  const refundState = await relatedRefundState(record.reversal.idempotencyKey);
  if (refundState === "terminal_failure") {
    await db.update(paymentTransferReversals).set({
      status: "canceled",
      failureMessage: "The related customer refund did not complete.",
      updatedAt: new Date(),
    }).where(and(
      eq(paymentTransferReversals.id, record.reversal.id),
      inArray(paymentTransferReversals.status, ["pending", "requires_action", "failed"]),
    ));
    return false;
  }
  if (refundState === "manual_review") {
    await db.update(paymentTransferReversals).set({
      status: "requires_action",
      failureMessage: "Part of the related multi-charge refund failed. Review the completed refund amount before reversing Scout funds.",
      updatedAt: new Date(),
    }).where(and(
      eq(paymentTransferReversals.id, record.reversal.id),
      inArray(paymentTransferReversals.status, ["pending", "requires_action", "failed"]),
    ));
    return false;
  }
  if (refundState !== "succeeded") return false;
  if (record.payment.livemode === null) {
    throw new Error("The payment Stripe mode must be reconciled before reversing this legacy transfer.");
  }
  if (record.payment.livemode !== getStripeLivemode()) {
    throw new Error("The transfer reversal belongs to a different Stripe mode.");
  }
  let stripeTransferId = record.transfer.stripeTransferId;
  if (!stripeTransferId) {
    const identity = await reconcilePaymentTransferIdentity(record.transfer.id);
    if (identity === "linked") {
      const [linked] = await db.select({ stripeTransferId: paymentTransfers.stripeTransferId })
        .from(paymentTransfers).where(eq(paymentTransfers.id, record.transfer.id)).limit(1);
      stripeTransferId = linked?.stripeTransferId ?? null;
    }
  }
  if (record.reversal.status === "succeeded") {
    await syncReversedTransfer(record.transfer.id, stripeTransferId);
    return true;
  }
  if (["failed", "canceled"].includes(record.reversal.status)) return false;
  if (!stripeTransferId) return settleUnsentReversalIntent(record.reversal, record.transfer);

  let stripeReversal: Stripe.TransferReversal;
  try {
    stripeReversal = record.reversal.stripeReversalId
      ? await getStripe().transfers.retrieveReversal(stripeTransferId, record.reversal.stripeReversalId)
      : await findStripeReversal(record.reversal, stripeTransferId)
        ?? await getStripe().transfers.createReversal(stripeTransferId, {
            amount: record.reversal.amountCents,
            metadata: {
              sendascout_reversal_id: record.reversal.id,
              sendascout_reversal_key: record.reversal.idempotencyKey,
              sendascout_transfer_id: record.transfer.id,
              sendascout_payment_id: record.transfer.paymentId,
              sendascout_mission_id: record.transfer.missionId,
            },
          }, { idempotencyKey: record.reversal.idempotencyKey });
  } catch (error) {
    await recordReversalFailure(record.reversal.id, error);
    return false;
  }

  if (stripeObjectId(stripeReversal.transfer) !== stripeTransferId) {
    throw new Error("Stripe returned a reversal for a different transfer.");
  }
  if (stripeReversal.amount !== record.reversal.amountCents || stripeReversal.currency !== record.transfer.currency) {
    throw new Error("Stripe returned a transfer reversal amount or currency that does not match the ledger.");
  }
  const mutableStatus = sql`${paymentTransferReversals.status} NOT IN ('succeeded', 'canceled')`;
  const [saved] = await db.update(paymentTransferReversals).set({
    stripeReversalId: stripeReversal.id,
    status: "succeeded",
    failureMessage: null,
    updatedAt: new Date(),
  }).where(and(
    eq(paymentTransferReversals.id, record.reversal.id),
    or(isNull(paymentTransferReversals.stripeReversalId), eq(paymentTransferReversals.stripeReversalId, stripeReversal.id)),
    mutableStatus,
  )).returning({ id: paymentTransferReversals.id });
  if (!saved) {
    const [current] = await db.select().from(paymentTransferReversals)
      .where(eq(paymentTransferReversals.id, record.reversal.id)).limit(1);
    if (current?.status === "succeeded" && current.stripeReversalId === stripeReversal.id) {
      await syncReversedTransfer(record.transfer.id, stripeTransferId);
      return true;
    }
    if (current?.status === "canceled") return false;
    throw new Error("The reversal ledger was linked to a different Stripe reversal.");
  }
  await syncReversedTransfer(record.transfer.id, stripeTransferId);
  return true;
}

async function allocateRefunds(input: {
  missionIds: string[];
  customerId: string;
  amountCents: number;
  missionCaseId: string | null;
  reason: string;
  existingPrefix: string;
  insertPrefix: string;
  reversal: ReversalAllocationInput | null;
}) {
  const params = [
    input.missionIds,
    input.customerId,
    `${input.existingPrefix}:%`,
    input.amountCents,
    input.missionCaseId,
    input.reason,
    input.insertPrefix,
    getStripeLivemode(),
  ];
  const rows = await serializableRequestRows(
    REFUND_ALLOCATION_SQL,
    params,
    input.reversal ? { ...input.reversal, missionIds: input.missionIds, paymentId: null } : null,
  );
  return { availableCents: Number(rows[0]?.available_cents ?? 0) };
}

async function allocatePaymentRefund(input: {
  paymentId: string;
  missionIds: string[];
  amountCents: number;
  missionCaseId: string | null;
  reason: string;
  existingPrefix: string;
  insertPrefix: string;
  reversal: ReversalAllocationInput | null;
}) {
  const rows = await serializableRequestRows(PAYMENT_REFUND_ALLOCATION_SQL, [
    input.paymentId,
    `${input.existingPrefix}:%`,
    input.amountCents,
    input.missionCaseId,
    input.reason,
    input.insertPrefix,
  ], input.reversal ? {
    ...input.reversal,
    missionIds: input.missionIds,
    paymentId: input.paymentId,
  } : null);
  return { availableCents: Number(rows[0]?.available_cents ?? 0) };
}

type ReversalAllocationInput = {
  amountCents: number;
  existingPrefix: string;
  insertPrefix: string;
  refundPolicyPrefix: string;
};

type ScopedReversalAllocationInput = ReversalAllocationInput & {
  missionIds: string[];
  paymentId: string | null;
};

async function serializableRequestRows(
  refundQuery: string,
  refundParams: unknown[],
  reversal: ScopedReversalAllocationInput | null,
) {
  const client = getDb().$client;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const results = await client.transaction(
        (transaction) => [
          transaction.query(refundQuery, refundParams),
          ...(reversal ? [transaction.query(REVERSAL_ALLOCATION_SQL, [
            reversal.missionIds,
            `${reversal.existingPrefix}:%`,
            reversal.amountCents,
            reversal.insertPrefix,
            reversal.paymentId,
            `${reversal.refundPolicyPrefix}:%`,
          ])] : []),
        ],
        { isolationLevel: "Serializable" },
      );
      return results[0] as Array<Record<string, unknown>>;
    } catch (error) {
      if (!isSerializationFailure(error) || attempt === 4) throw error;
    }
  }
  throw new Error("The payment allocation could not be serialized.");
}

async function serializableRows(query: string, params: unknown[]) {
  const client = getDb().$client;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const [rows] = await client.transaction(
        (transaction) => [transaction.query(query, params)],
        { isolationLevel: "Serializable" },
      );
      return rows as Array<Record<string, unknown>>;
    } catch (error) {
      if (!isSerializationFailure(error) || attempt === 4) throw error;
    }
  }
  throw new Error("The transfer reversal allocation could not be serialized.");
}

async function missionScope(missionId: string, missionCaseId: string | null) {
  const db = getDb();
  const [target] = await db.select({
    id: missions.id,
    bundleId: missions.bundleId,
    customerId: missions.customerId,
  }).from(missions).where(eq(missions.id, missionId)).limit(1);
  if (!target) throw new Error("Mission not found for refund.");
  const scopedMissions = target.bundleId
    ? await db.select({ id: missions.id }).from(missions)
      .where(eq(missions.bundleId, target.bundleId))
    : [{ id: target.id }];
  const missionIds = scopedMissions.map((mission) => mission.id);
  if (missionCaseId) {
    const [missionCase] = await db.select({ missionId: missionCases.missionId }).from(missionCases)
      .where(eq(missionCases.id, missionCaseId)).limit(1);
    if (!missionCase || !missionIds.includes(missionCase.missionId)) {
      throw new Error("The mission case does not belong to this refund scope.");
    }
  }
  return { customerId: target.customerId, missionIds };
}

async function paymentRefundScope(paymentId: string, missionCaseId: string | null) {
  const db = getDb();
  const [target] = await db.select({
    paymentId: payments.id,
    missionId: missions.id,
    bundleId: missions.bundleId,
    stripeChargeId: payments.stripeChargeId,
    livemode: payments.livemode,
  }).from(payments)
    .innerJoin(missions, eq(missions.id, payments.missionId))
    .where(eq(payments.id, paymentId))
    .limit(1);
  if (!target) throw new Error("Payment charge not found for refund.");
  if (!target.stripeChargeId) throw new Error("The payment does not have a Stripe charge to refund.");
  if (target.livemode === null) {
    throw new Error("The payment Stripe mode must be reconciled before allocating a refund.");
  }
  if (target.livemode !== getStripeLivemode()) {
    throw new Error("The payment refund belongs to a different Stripe mode.");
  }
  const scopedMissions = target.bundleId
    ? await db.select({ id: missions.id }).from(missions).where(eq(missions.bundleId, target.bundleId))
    : [{ id: target.missionId }];
  const missionIds = scopedMissions.map((mission) => mission.id);
  if (missionCaseId) {
    const [missionCase] = await db.select({ missionId: missionCases.missionId }).from(missionCases)
      .where(eq(missionCases.id, missionCaseId)).limit(1);
    if (!missionCase || !missionIds.includes(missionCase.missionId)) {
      throw new Error("The mission case does not belong to this payment's refund scope.");
    }
  }
  return { missionIds };
}

async function ensureMissingReversalIntent(refund: {
  paymentId: string;
  idempotencyKey: string;
}) {
  const match = /^refund:v1:([a-f0-9]{32}):(mission|payment_([0-9a-f-]{36})):reverse_([0-9]+):([0-9a-f-]{36})$/i
    .exec(refund.idempotencyKey);
  if (!match) return false;
  const amountCents = positiveCents(Number(match[4]), "Scout reversal amount");
  const exactPaymentId = match[3] ?? null;
  if (match[5].toLowerCase() !== refund.paymentId.toLowerCase()
    || (exactPaymentId && exactPaymentId.toLowerCase() !== refund.paymentId.toLowerCase())) {
    throw new Error("The durable reversal policy does not match its refund payment scope.");
  }
  const scope = await paymentRefundScope(refund.paymentId, null);
  if (await hasLegacyTransfer(scope.missionIds)) {
    throw new Error("A legacy Stripe transfer requires manual reconciliation before reversal.");
  }
  const hash = match[1].toLowerCase();
  const scopePolicy = match[2].toLowerCase();
  const rows = await serializableRows(REVERSAL_ALLOCATION_SQL, [
    scope.missionIds,
    `reversal:v1:${hash}:%`,
    amountCents,
    `reversal:v1:${hash}:${scopePolicy}:reverse_${amountCents}`,
    exactPaymentId,
    `refund:v1:${hash}:${scopePolicy}:reverse_${amountCents}:%`,
  ]);
  return Number(rows[0]?.inserted_count ?? 0) > 0;
}

async function refundRowsForPrefix(prefix: string) {
  return getDb().select().from(paymentRefunds)
    .where(like(paymentRefunds.idempotencyKey, `${prefix}:%`))
    .orderBy(asc(paymentRefunds.createdAt), asc(paymentRefunds.id));
}

async function reversalRowsForPrefix(prefix: string) {
  return getDb().select().from(paymentTransferReversals)
    .where(like(paymentTransferReversals.idempotencyKey, `${prefix}:%`))
    .orderBy(asc(paymentTransferReversals.createdAt), asc(paymentTransferReversals.id));
}

async function relatedRefundState(
  reversalKey: string,
): Promise<"pending" | "terminal_failure" | "manual_review" | "succeeded"> {
  const hash = /^reversal:v1:([a-f0-9]{32}):/.exec(reversalKey)?.[1];
  if (!hash) return "terminal_failure";
  const rows = await refundRowsForPrefix(`refund:v1:${hash}`);
  if (!rows.length) return "terminal_failure";
  const hasSucceeded = rows.some((row) => row.status === "succeeded");
  const hasTerminalFailure = rows.some((row) => row.status === "failed" || row.status === "canceled");
  if (hasSucceeded && hasTerminalFailure) return "manual_review";
  if (hasTerminalFailure) return "terminal_failure";
  return rows.every((row) => row.status === "succeeded") ? "succeeded" : "pending";
}

async function hasLegacyTransfer(missionIds: string[]) {
  const [legacy] = await getDb().select({ id: payments.id }).from(payments).where(and(
    inArray(payments.missionId, missionIds),
    sql`${payments.legacyStripeTransferId} IS NOT NULL`,
  )).limit(1);
  return Boolean(legacy);
}

export async function syncRefundedPayment(paymentId: string): Promise<void> {
  const syncSql = `
    WITH succeeded_refunds AS (
      SELECT COALESCE(SUM(refund.amount_cents), 0) AS amount_cents
      FROM payment_refunds AS refund
      WHERE refund.payment_id = $1::uuid
        AND refund.status = 'succeeded'
    ), target_dispute AS (
      SELECT EXISTS (
        SELECT 1
        FROM payment_disputes AS dispute
        WHERE dispute.payment_id = $1::uuid
          AND dispute.status NOT IN ('won', 'prevented', 'warning_closed')
      ) AS active
    ), updated_payment AS (
      UPDATE payments AS payment
      SET refunded_amount_cents = LEAST(
            payment.amount_cents,
            GREATEST(payment.refunded_amount_cents, (SELECT amount_cents FROM succeeded_refunds))
          ),
          status = CASE
            WHEN (SELECT active FROM target_dispute)
              THEN 'disputed'::payment_transaction_status
            WHEN GREATEST(payment.refunded_amount_cents, (SELECT amount_cents FROM succeeded_refunds)) >= payment.amount_cents
              THEN 'refunded'::payment_transaction_status
            WHEN GREATEST(payment.refunded_amount_cents, (SELECT amount_cents FROM succeeded_refunds)) > 0
              THEN 'partially_refunded'::payment_transaction_status
            ELSE payment.status
          END,
          disputed_at = CASE
            WHEN (SELECT active FROM target_dispute) THEN COALESCE(payment.disputed_at, now())
            ELSE NULL
          END,
          updated_at = now()
      WHERE payment.id = $1::uuid
      RETURNING payment.id,
                payment.mission_id,
                payment.mission_review_id,
                payment.kind,
                payment.amount_cents,
                payment.refunded_amount_cents,
                payment.status
    ), target_scope AS MATERIALIZED (
      SELECT mission.id AS mission_id, mission.bundle_id
      FROM missions AS mission
      INNER JOIN updated_payment ON updated_payment.mission_id = mission.id
    ), scope_missions AS MATERIALIZED (
      SELECT scoped.id
      FROM missions AS scoped
      CROSS JOIN target_scope
      WHERE scoped.id = target_scope.mission_id
         OR (target_scope.bundle_id IS NOT NULL AND scoped.bundle_id = target_scope.bundle_id)
    ), effective_payments AS MATERIALIZED (
      SELECT payment.id,
             payment.amount_cents,
             CASE
               WHEN payment.id = updated_payment.id THEN updated_payment.refunded_amount_cents
               ELSE payment.refunded_amount_cents
             END AS refunded_amount_cents
      FROM payments AS payment
      INNER JOIN scope_missions ON scope_missions.id = payment.mission_id
      CROSS JOIN updated_payment
      WHERE payment.stripe_charge_id IS NOT NULL
        AND payment.kind NOT IN ('tip', 'duplicate')
    ), scope_totals AS MATERIALIZED (
      SELECT COALESCE(SUM(effective.amount_cents), 0) AS amount_cents,
             COALESCE(SUM(LEAST(effective.amount_cents, effective.refunded_amount_cents)), 0) AS refunded_amount_cents
      FROM effective_payments AS effective
    ), active_dispute AS MATERIALIZED (
      SELECT EXISTS (
        SELECT 1
        FROM payment_disputes AS dispute
        INNER JOIN payments AS disputed_payment ON disputed_payment.id = dispute.payment_id
        INNER JOIN scope_missions ON scope_missions.id = disputed_payment.mission_id
        WHERE dispute.status NOT IN ('won', 'prevented', 'warning_closed')
          AND disputed_payment.kind NOT IN ('tip', 'duplicate')
      ) AS present
    ), aggregate_status AS MATERIALIZED (
      SELECT CASE
        WHEN (SELECT present FROM active_dispute)
          THEN 'disputed'::payment_status
        WHEN totals.amount_cents > 0 AND totals.refunded_amount_cents >= totals.amount_cents
          THEN 'refunded'::payment_status
        WHEN totals.refunded_amount_cents > 0
          THEN 'partially_refunded'::payment_status
        ELSE 'paid'::payment_status
      END AS status
      FROM scope_totals AS totals
    ), updated_review AS (
      UPDATE mission_reviews AS review
      SET tip_status = CASE
            WHEN updated_payment.status = 'refunded'
              THEN 'refunded'::payment_status
            WHEN updated_payment.status = 'partially_refunded'
              THEN 'partially_refunded'::payment_status
            WHEN updated_payment.status = 'disputed'
              THEN 'disputed'::payment_status
            ELSE review.tip_status
          END
      FROM updated_payment
      WHERE updated_payment.kind = 'tip'
        AND review.id = updated_payment.mission_review_id
      RETURNING review.id
    ), updated_missions AS (
      UPDATE missions AS mission
      SET payment_status = (SELECT status FROM aggregate_status),
          updated_at = now()
      WHERE mission.id IN (SELECT id FROM scope_missions)
        AND mission.archived_at IS NULL
      RETURNING mission.id
    ), updated_bundle AS (
      UPDATE mission_bundles AS bundle
      SET payment_status = (SELECT status FROM aggregate_status),
          updated_at = now()
      WHERE bundle.id = (SELECT bundle_id FROM target_scope)
      RETURNING bundle.id
    )
    SELECT (SELECT COUNT(*)::integer FROM updated_payment) AS payment_count,
           (SELECT COUNT(*)::integer FROM updated_review) AS review_count,
           (SELECT COUNT(*)::integer FROM updated_missions) AS mission_count,
           (SELECT COUNT(*)::integer FROM updated_bundle) AS bundle_count
  `;
  const client = getDb().$client;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const results = await client.transaction(
        (transaction) => [
          transaction.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('stripe-dispute-payment:' || $1::text, 0))",
            [paymentId],
          ),
          transaction.query(`
            SELECT pg_advisory_xact_lock(hashtextextended(
              'stripe-financial-scope:' || CASE
                WHEN mission.bundle_id IS NOT NULL THEN 'bundle:' || mission.bundle_id::text
                ELSE 'mission:' || mission.id::text
              END,
              0
            ))
            FROM payments AS payment
            INNER JOIN missions AS mission ON mission.id = payment.mission_id
            WHERE payment.id = $1::uuid
          `, [paymentId]),
          transaction.query(syncSql, [paymentId]),
        ],
        { isolationLevel: "ReadCommitted" },
      );
      const syncRows = results[2] as Array<Record<string, unknown>>;
      if (Number(syncRows[0]?.payment_count ?? 0) !== 1) {
        throw new Error("Payment scope not found during refund synchronization.");
      }
      return;
    } catch (error) {
      if (!isSerializationFailure(error) || attempt === 4) throw error;
    }
  }
  throw new Error("The payment refund synchronization could not be serialized.");
}

async function findStripeRefund(refund: RefundRow, stripeChargeId: string) {
  for await (const candidate of getStripe().refunds.list({ charge: stripeChargeId, limit: 100 })) {
    if (candidate.metadata?.sendascout_refund_id === refund.id
      || candidate.metadata?.sendascout_refund_key === refund.idempotencyKey) {
      return candidate;
    }
  }
  return null;
}

async function findStripeReversal(reversal: ReversalRow, stripeTransferId: string) {
  for await (const candidate of getStripe().transfers.listReversals(stripeTransferId, { limit: 100 })) {
    if (candidate.metadata?.sendascout_reversal_id === reversal.id
      || candidate.metadata?.sendascout_reversal_key === reversal.idempotencyKey) {
      return candidate;
    }
  }
  return null;
}

async function settleUnsentReversalIntent(reversal: ReversalRow, transfer: TransferRow) {
  // Case-authorized manual transfers remain eligible for settlement even after a
  // refund succeeds. Preserve their reversal intent until settlement either
  // links a Stripe transfer or an operator terminally resolves the transfer.
  if (transfer.kind === "manual" && transfer.idempotencyKey.startsWith("transfer:case:")) {
    await getDb().update(paymentTransferReversals).set({
      failureMessage: "Waiting for the case-authorized Scout transfer to settle before reversing it.",
      updatedAt: new Date(),
    }).where(and(
      eq(paymentTransferReversals.id, reversal.id),
      eq(paymentTransferReversals.status, "pending"),
    ));
    return false;
  }

  const staleAt = Date.now() - 15 * 60 * 1000;
  if (transfer.updatedAt.getTime() > staleAt) {
    await getDb().update(paymentTransferReversals).set({
      failureMessage: "Waiting for the related Stripe transfer outcome to reconcile.",
      updatedAt: new Date(),
    }).where(and(
      eq(paymentTransferReversals.id, reversal.id),
      eq(paymentTransferReversals.status, "pending"),
    ));
    return false;
  }

  await getDb().update(paymentTransferReversals).set({
    status: "canceled",
    failureMessage: "No matching Stripe transfer was sent; no Scout funds needed to be reversed.",
    updatedAt: new Date(),
  }).where(and(
    eq(paymentTransferReversals.id, reversal.id),
    eq(paymentTransferReversals.status, "pending"),
    sql`EXISTS (
      SELECT 1
      FROM payment_transfers AS current_transfer
      WHERE current_transfer.id = ${transfer.id}
        AND current_transfer.stripe_transfer_id IS NULL
        AND current_transfer.status IN ('pending', 'processing', 'failed')
        AND current_transfer.updated_at <= ${new Date(staleAt)}
    )`,
  ));
  return false;
}

async function syncReversedTransfer(transferId: string, stripeTransferId: string | null) {
  if (!stripeTransferId) return;
  const [ledger] = await getDb().select().from(paymentTransfers).where(and(
    eq(paymentTransfers.id, transferId),
    eq(paymentTransfers.stripeTransferId, stripeTransferId),
  )).limit(1);
  if (!ledger) throw new Error("Transfer ledger entry not found during reversal reconciliation.");
  const transfer = await getStripe().transfers.retrieve(stripeTransferId);
  if (transfer.amount !== ledger.amountCents || transfer.currency !== ledger.currency) {
    throw new Error("Stripe transfer amount or currency does not match the reversal ledger.");
  }
  const reversedAmountCents = Math.max(0, Math.min(transfer.amount, transfer.amount_reversed));
  await getDb().update(paymentTransfers).set({
    reversedAmountCents: sql`GREATEST(${paymentTransfers.reversedAmountCents}, ${reversedAmountCents})`,
    status: reversedAmountCents >= transfer.amount ? "reversed" : reversedAmountCents > 0 ? "partially_reversed" : "succeeded",
    reversedAt: reversedAmountCents > 0 ? new Date() : null,
    updatedAt: new Date(),
  }).where(and(eq(paymentTransfers.id, transferId), eq(paymentTransfers.stripeTransferId, stripeTransferId)));
}

async function recordRefundFailure(refundId: string, error: unknown) {
  const details = stripeErrorDetails(error);
  const terminal = terminalStripeFailure(details.type, details.code);
  await getDb().update(paymentRefunds).set({
    status: terminal ? "failed" : "pending",
    failureCode: details.code,
    failureMessage: details.message.slice(0, 1000),
    updatedAt: new Date(),
  }).where(and(
    eq(paymentRefunds.id, refundId),
    inArray(paymentRefunds.status, ["pending", "requires_action"]),
  ));
  console.error("Stripe refund processing failed", { refundId, code: details.code, type: details.type, terminal });
}

async function recordReversalFailure(reversalId: string, error: unknown) {
  const details = stripeErrorDetails(error);
  const terminal = terminalStripeFailure(details.type, details.code);
  await getDb().update(paymentTransferReversals).set({
    status: terminal ? "failed" : "pending",
    failureMessage: `${details.code}: ${details.message}`.slice(0, 1000),
    updatedAt: new Date(),
  }).where(and(
    eq(paymentTransferReversals.id, reversalId),
    inArray(paymentTransferReversals.status, ["pending", "requires_action"]),
  ));
  console.error("Stripe transfer reversal failed", { reversalId, code: details.code, type: details.type, terminal });
}

async function validateRefundReplay(
  refunds: RefundRow[],
  missionIds: string[],
  amountCents: number,
  missionCaseId: string | null,
  reason: string,
  expectedPrefix: string,
  allowTipPayments: boolean,
) {
  const total = refunds.reduce((sum, refund) => sum + refund.amountCents, 0);
  if (total !== amountCents) throw new Error("This refund idempotency key was already used with a different amount.");
  if (refunds.some((refund) => refund.missionCaseId !== missionCaseId || refund.reason !== reason)) {
    throw new Error("This refund idempotency key was already used with different request details.");
  }
  if (refunds.some((refund) => !refund.idempotencyKey.startsWith(`${expectedPrefix}:`))) {
    throw new Error("This refund idempotency key was already used with a different Scout reversal policy.");
  }
  const paymentIds = [...new Set(refunds.map((refund) => refund.paymentId))];
  if (!paymentIds.length) throw new Error("The refund request did not allocate a payment.");
  await assertRefundPaymentsInScope(paymentIds, missionIds, allowTipPayments);
}

async function assertRefundPaymentsInScope(paymentIds: string[], missionIds: string[], allowTipPayments: boolean) {
  const rows = await getDb().select({
    id: payments.id,
    missionId: payments.missionId,
    kind: payments.kind,
    stripeChargeId: payments.stripeChargeId,
    livemode: payments.livemode,
  }).from(payments)
    .where(inArray(payments.id, paymentIds));
  if (rows.length !== paymentIds.length || rows.some((row) => !missionIds.includes(row.missionId))) {
    throw new Error("This refund idempotency key was already used for a different mission.");
  }
  if (!allowTipPayments && rows.some((row) => ["tip", "duplicate"].includes(row.kind))) {
    throw new Error("Mission-level refunds cannot include tips or isolated duplicate charges; refund those exact payments separately.");
  }
  if (rows.some((row) => !row.stripeChargeId || row.livemode !== getStripeLivemode())) {
    throw new Error("This refund request includes a charge from an incompatible Stripe mode.");
  }
}

function validateReversalReplay(reversals: ReversalRow[], expectedPrefix: string) {
  if (reversals.some((reversal) => !reversal.idempotencyKey.startsWith(`${expectedPrefix}:`))) {
    throw new Error("This refund idempotency key was already used with a different Scout reversal amount.");
  }
}

async function assertReversalsForPayment(reversals: ReversalRow[], paymentId: string) {
  if (!reversals.length) return;
  const transferIds = [...new Set(reversals.map((reversal) => reversal.transferId))];
  const rows = await getDb().select({ id: paymentTransfers.id, paymentId: paymentTransfers.paymentId })
    .from(paymentTransfers)
    .where(inArray(paymentTransfers.id, transferIds));
  if (rows.length !== transferIds.length || rows.some((row) => row.paymentId !== paymentId)) {
    throw new Error("This refund idempotency key was already used for a different Scout transfer.");
  }
}

async function assertReversalsInMissionScope(
  reversals: ReversalRow[],
  missionIds: string[],
  allowTipPayments: boolean,
) {
  if (!reversals.length) return;
  const transferIds = [...new Set(reversals.map((reversal) => reversal.transferId))];
  const rows = await getDb().select({
    id: paymentTransfers.id,
    missionId: payments.missionId,
    paymentKind: payments.kind,
  }).from(paymentTransfers)
    .innerJoin(payments, eq(payments.id, paymentTransfers.paymentId))
    .where(inArray(paymentTransfers.id, transferIds));
  if (rows.length !== transferIds.length || rows.some((row) => !missionIds.includes(row.missionId))) {
    throw new Error("This refund idempotency key was already used for a different Scout transfer scope.");
  }
  if (!allowTipPayments && rows.some((row) => row.paymentKind === "tip")) {
    throw new Error("Mission-level refunds cannot reverse tip transfers; refund the exact tip payment separately.");
  }
}

type RefundScopeIdentity = { kind: "mission" } | { kind: "payment"; paymentId: string };

function requestPrefixes(
  requestKey: string,
  reverseScoutTransfer: boolean,
  reversalAmountCents: number,
  scope: RefundScopeIdentity,
) {
  const hash = createHash("sha256").update(requestKey).digest("hex").slice(0, 32);
  const scopePolicy = scope.kind === "payment" ? `payment_${scope.paymentId.toLowerCase()}` : "mission";
  const policy = reverseScoutTransfer ? `reverse_${reversalAmountCents}` : "no_reversal";
  return {
    refundBase: `refund:v1:${hash}`,
    refund: `refund:v1:${hash}:${scopePolicy}:${policy}`,
    reversalBase: `reversal:v1:${hash}`,
    reversal: `reversal:v1:${hash}:${scopePolicy}:${policy}`,
  };
}

function cleanRequestKey(value: string) {
  const key = value.trim();
  if (key.length < 8 || key.length > 200) throw new Error("Provide a stable refund idempotency key between 8 and 200 characters.");
  return key;
}

function cleanReason(value?: string) {
  const reason = value?.trim() || "requested_by_customer";
  if (reason.length > 200) throw new Error("Refund reasons are limited to 200 characters.");
  return reason;
}

function positiveCents(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error(`${label} must be a positive whole-cent amount within the payment ledger limit.`);
  }
  return value;
}

function boundedLimit(limit: number) {
  return Math.max(1, Math.min(100, Number.isSafeInteger(limit) ? limit : 25));
}

function ledgerAmount<T extends { amountCents: number; status: string }>(rows: T[], statuses: string[]) {
  return rows.filter((row) => statuses.includes(row.status)).reduce((sum, row) => sum + row.amountCents, 0);
}

function stripeRefundReason(reason: string): Stripe.RefundCreateParams.Reason {
  return reason === "duplicate" || reason === "fraudulent" ? reason : "requested_by_customer";
}

function stripeRefundStatus(status: string | null): RefundStatus {
  if (status === "succeeded" || status === "failed" || status === "canceled" || status === "requires_action") return status;
  return "pending";
}

function refundFailureMessage(refund: Stripe.Refund) {
  if (refund.failure_balance_transaction) {
    return `Failure balance transaction: ${stripeObjectId(refund.failure_balance_transaction)}`;
  }
  return refund.failure_reason ?? null;
}

function terminalStripeFailure(type: string, code: string) {
  if (type === "StripeCardError") return true;
  if (type !== "StripeInvalidRequestError") return false;
  return !["balance_insufficient", "lock_timeout", "rate_limit"].includes(code);
}

function isSerializationFailure(error: unknown) {
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === "40001" || String(candidate.message ?? "").toLowerCase().includes("could not serialize access");
}

function money(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown reconciliation error";
}
