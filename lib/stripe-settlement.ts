import "server-only";

import { and, asc, eq, inArray, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { getDb } from "@/db";
import {
  missionBundles,
  missionCases,
  missions,
  paymentDisputes,
  paymentRefunds,
  payments,
  paymentTransfers,
  scoutProfiles,
} from "@/db/schema";
import { notifyUser } from "@/lib/notifications";
import { scoutConnectReady } from "@/lib/stripe-connect";
import { LATE_PAYMENT_REFUND_CODE } from "@/lib/stripe-late-payment-refunds";
import {
  nextScoutTransferReleaseAt,
  scoutTransferReleaseIsOpen,
  stripeBalanceSettingsUseRequiredFridaySchedule,
} from "@/lib/stripe-payout-schedule";
import { getStripe, getStripeLivemode, stripeErrorDetails, stripeObjectId } from "@/lib/stripe";

export type SettlementResult = {
  state: "not_complete" | "no_scout" | "payout_not_ready" | "payment_mismatch" | "queued";
  queued: number;
  processed: number;
};

export async function settleMissionBestEffort(missionId: string, source: string) {
  try {
    const result = await enqueueMissionSettlement(missionId);
    if (result.state !== "queued") {
      console.info("Mission settlement deferred", { missionId, source, state: result.state });
    }
    return result;
  } catch (error) {
    console.error("Mission settlement could not be queued", { missionId, source, error });
    return null;
  }
}

export async function reconcileCompletedMissionSettlements(options: { limit?: number; scoutId?: string } = {}) {
  const db = getDb();
  const livemode = getStripeLivemode();
  const limit = Math.max(1, Math.min(250, options.limit ?? 100));
  const rows = await db.execute(sql`
    SELECT root.id::text
    FROM missions AS root
    LEFT JOIN mission_bundles AS parent ON parent.id = root.bundle_id
    INNER JOIN scout_profiles AS profile ON profile.user_id = root.scout_id
    WHERE (${options.scoutId ?? null}::uuid IS NULL OR profile.user_id = ${options.scoutId ?? null}::uuid)
      AND profile.stripe_account_id IS NOT NULL
      AND profile.stripe_account_livemode = ${livemode}
      AND profile.stripe_connect_status = 'ready'
      AND profile.stripe_transfers_active = TRUE
      AND profile.payouts_enabled = TRUE
      AND profile.stripe_payout_schedule_configured_at IS NOT NULL
      AND (
        (root.bundle_id IS NULL AND root.status = 'completed')
        OR (
          root.bundle_id IS NOT NULL
          AND root.bundle_sequence = 1
          AND parent.status = 'completed'
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM mission_cases AS financial_case
        INNER JOIN missions AS case_mission ON case_mission.id = financial_case.mission_id
        WHERE financial_case.status = 'resolved'
          AND (
            financial_case.resolution = 'cancel'
            OR (
              financial_case.resolution = 'complete'
              AND (financial_case.refund_amount_cents > 0 OR financial_case.payout_amount_cents > 0)
            )
          )
          AND (
            (root.bundle_id IS NULL AND case_mission.id = root.id)
            OR (root.bundle_id IS NOT NULL AND case_mission.bundle_id = root.bundle_id)
          )
      )
      AND EXISTS (
        SELECT 1
        FROM payments AS funding_payment
        WHERE funding_payment.status = 'paid'
          AND funding_payment.scout_payout_cents > 0
          AND funding_payment.livemode = ${livemode}
          AND funding_payment.failure_code IS DISTINCT FROM ${LATE_PAYMENT_REFUND_CODE}
          AND funding_payment.legacy_stripe_transfer_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM payment_transfers AS existing_transfer
            WHERE existing_transfer.payment_id = funding_payment.id
          )
          AND (
            (root.bundle_id IS NULL AND funding_payment.mission_id = root.id)
            OR (
              root.bundle_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM missions AS funding_leg
                WHERE funding_leg.id = funding_payment.mission_id
                  AND funding_leg.bundle_id = root.bundle_id
              )
            )
          )
      )
    ORDER BY COALESCE(parent.completed_at, root.completed_at) ASC NULLS LAST
    LIMIT ${limit}
  `) as unknown as Array<{ id: string }>;

  let reconciled = 0;
  for (const row of rows) {
    const result = await settleMissionBestEffort(row.id, "completed_reconciliation");
    if (result?.state === "queued") reconciled += 1;
  }
  return { found: rows.length, reconciled };
}

export async function enqueueMissionSettlement(missionId: string): Promise<SettlementResult> {
  const db = getDb();
  const [mission] = await db.select().from(missions).where(eq(missions.id, missionId)).limit(1);
  if (!mission) throw new Error("Mission not found for settlement.");

  const [bundle] = mission.bundleId
    ? await db.select().from(missionBundles).where(eq(missionBundles.id, mission.bundleId)).limit(1)
    : [null];
  const legs = bundle
    ? await db.select().from(missions).where(eq(missions.bundleId, bundle.id)).orderBy(asc(missions.bundleSequence))
    : [mission];
  const root = legs[0] ?? mission;
  const bookingComplete = bundle
    ? bundle.status === "completed" && legs.length > 0 && legs.every((leg) => leg.status === "completed")
    : mission.status === "completed";
  if (!bookingComplete) return { state: "not_complete", queued: 0, processed: 0 };
  const scoutId = root.scoutId ?? mission.scoutId;
  if (!scoutId || legs.some((leg) => leg.scoutId !== scoutId)) return { state: "no_scout", queued: 0, processed: 0 };

  const [profile] = await db.select().from(scoutProfiles).where(eq(scoutProfiles.userId, scoutId)).limit(1);
  if (!profile || !scoutConnectReady(profile, getStripeLivemode()) || !profile.stripeAccountId) return { state: "payout_not_ready", queued: 0, processed: 0 };
  if (profile.stripeAccountLivemode !== getStripeLivemode()) {
    throw new Error("Scout payout account belongs to a different Stripe mode.");
  }

  const missionIds = legs.map((leg) => leg.id);
  const [financialCase] = await db.select({ id: missionCases.id }).from(missionCases).where(and(
    inArray(missionCases.missionId, missionIds),
    eq(missionCases.status, "resolved"),
    sql`(
      ${missionCases.resolution} = 'cancel'
      OR (
        ${missionCases.resolution} = 'complete'
        AND (${missionCases.refundAmountCents} > 0 OR ${missionCases.payoutAmountCents} > 0)
      )
    )`,
  )).limit(1);
  if (financialCase) return { state: "payment_mismatch", queued: 0, processed: 0 };
  const paymentRows = await db.select().from(payments).where(and(
    inArray(payments.missionId, missionIds),
    eq(payments.status, "paid"),
  )).orderBy(asc(payments.createdAt));
  const nonTipPayments = paymentRows.filter((payment) => !["tip", "duplicate"].includes(payment.kind));
  const expectedCustomerCents = bundle?.customerPriceCents ?? root.customerPriceCents;
  const expectedScoutCents = bundle?.scoutPayoutCents ?? root.scoutPayoutCents;
  const fundedCustomerCents = nonTipPayments.reduce((sum, payment) => sum + payment.amountCents, 0);
  const fundedScoutCents = nonTipPayments.reduce((sum, payment) => sum + payment.scoutPayoutCents, 0);
  if (fundedCustomerCents !== expectedCustomerCents || fundedScoutCents !== expectedScoutCents) {
    return { state: "payment_mismatch", queued: 0, processed: 0 };
  }

  if (paymentRows.some((payment) => (
    payment.livemode !== getStripeLivemode()
    || payment.refundedAmountCents > 0
    || payment.failureCode === LATE_PAYMENT_REFUND_CODE
  ))) {
    return { state: "payment_mismatch", queued: 0, processed: 0 };
  }

  const paymentIds = paymentRows.map((payment) => payment.id);
  if (paymentIds.length) {
    const [activeRefund, activeDispute] = await Promise.all([
      db.select({ id: paymentRefunds.id }).from(paymentRefunds).where(and(
        inArray(paymentRefunds.paymentId, paymentIds),
        inArray(paymentRefunds.status, ["pending", "requires_action", "succeeded"]),
      )).limit(1),
      db.select({ id: paymentDisputes.id }).from(paymentDisputes).where(and(
        inArray(paymentDisputes.paymentId, paymentIds),
        notInArray(paymentDisputes.status, ["won", "prevented", "warning_closed"]),
      )).limit(1),
    ]);
    if (activeRefund[0] || activeDispute[0]) {
      return { state: "payment_mismatch", queued: 0, processed: 0 };
    }
  }

  const transferable = paymentRows.filter((payment) => payment.scoutPayoutCents > 0 && payment.stripeChargeId && !payment.legacyStripeTransferId);
  if (transferable.length !== paymentRows.filter((payment) => payment.scoutPayoutCents > 0).length) {
    return { state: "payment_mismatch", queued: 0, processed: 0 };
  }
  let insertedCount = 0;
  if (transferable.length) {
    const releaseAttemptedAt = new Date();
    const nextAttemptAt = scoutTransferReleaseIsOpen(releaseAttemptedAt)
      ? releaseAttemptedAt
      : nextScoutTransferReleaseAt(releaseAttemptedAt);
    const inserted = await db.insert(paymentTransfers).values(transferable.map((payment) => ({
      paymentId: payment.id,
      missionId: payment.missionId,
      bundleId: bundle?.id ?? null,
      scoutId,
      stripeAccountId: profile.stripeAccountId!,
      kind: transferKind(payment.kind),
      amountCents: payment.scoutPayoutCents,
      currency: payment.currency,
      sourceChargeId: payment.stripeChargeId!,
      stripeTransferGroup: payment.stripeTransferGroup,
      idempotencyKey: `transfer:${payment.id}:scout:${scoutId}:v1`,
      status: "pending" as const,
      nextAttemptAt,
    }))).onConflictDoNothing({ target: paymentTransfers.paymentId }).returning({ id: paymentTransfers.id });
    insertedCount = inserted.length;
  }

  let processed = 0;
  const transfers = transferable.length
    ? await db.select().from(paymentTransfers).where(inArray(paymentTransfers.paymentId, transferable.map((payment) => payment.id)))
    : [];
  const expectedByPayment = new Map(transferable.map((payment) => [payment.id, payment]));
  for (const transfer of transfers) {
    const payment = expectedByPayment.get(transfer.paymentId);
    if (
      !payment
      || transfer.missionId !== payment.missionId
      || transfer.bundleId !== (bundle?.id ?? null)
      || transfer.scoutId !== scoutId
      || transfer.stripeAccountId !== profile.stripeAccountId
      || transfer.kind !== transferKind(payment.kind)
      || transfer.amountCents !== payment.scoutPayoutCents
      || transfer.currency !== payment.currency
      || transfer.sourceChargeId !== payment.stripeChargeId
      || transfer.stripeTransferGroup !== payment.stripeTransferGroup
    ) {
      throw new Error(`Existing transfer ${transfer.id} does not match its funding payment.`);
    }
  }
  for (const transfer of transfers) {
    if (await processPaymentTransfer(transfer.id)) processed += 1;
  }
  return { state: "queued", queued: insertedCount, processed };
}

export async function settleCasePayoutBestEffort(caseId: string, source: string) {
  try {
    const result = await enqueueCasePayout(caseId);
    if (result.state !== "queued") {
      console.info("Case payout deferred", { caseId, source, state: result.state });
    }
    return result;
  } catch (error) {
    console.error("Case payout could not be queued", { caseId, source, error });
    return null;
  }
}

export async function reconcileCasePayouts(limit = 100) {
  const rows = await getDb().execute(sql`
    SELECT financial_case.id::text
    FROM mission_cases AS financial_case
    WHERE financial_case.status = 'resolved'
      AND financial_case.resolution IN ('cancel', 'complete')
      AND financial_case.payout_amount_cents > 0
      AND COALESCE((
        SELECT SUM(case_transfer.amount_cents)
        FROM payment_transfers AS case_transfer
        WHERE case_transfer.idempotency_key LIKE
          ('transfer:case:' || financial_case.id::text || ':payment:%')
      ), 0) < financial_case.payout_amount_cents
    ORDER BY financial_case.resolved_at ASC NULLS LAST, financial_case.created_at ASC
    LIMIT ${Math.max(1, Math.min(250, limit))}
  `) as unknown as Array<{ id: string }>;

  let reconciled = 0;
  for (const row of rows) {
    const result = await settleCasePayoutBestEffort(row.id, "case_payout_reconciliation");
    if (result?.state === "queued") reconciled += 1;
  }
  return { found: rows.length, reconciled };
}

export async function enqueueCasePayout(caseId: string): Promise<SettlementResult> {
  const db = getDb();
  const [item] = await db.select({ missionCase: missionCases, mission: missions, bundle: missionBundles })
    .from(missionCases)
    .innerJoin(missions, eq(missions.id, missionCases.missionId))
    .leftJoin(missionBundles, eq(missionBundles.id, missions.bundleId))
    .where(eq(missionCases.id, caseId))
    .limit(1);
  if (!item) throw new Error("Mission case not found for payout.");
  if (
    item.missionCase.status !== "resolved"
    || !["cancel", "complete"].includes(item.missionCase.resolution ?? "")
  ) {
    return { state: "not_complete", queued: 0, processed: 0 };
  }
  if (item.missionCase.payoutAmountCents <= 0) {
    return { state: "queued", queued: 0, processed: 0 };
  }

  const legs = item.bundle
    ? await db.select().from(missions).where(eq(missions.bundleId, item.bundle.id)).orderBy(asc(missions.bundleSequence))
    : [item.mission];
  const scoutId = item.mission.scoutId ?? legs[0]?.scoutId ?? null;
  if (!scoutId || !legs.length || legs.some((leg) => leg.scoutId !== scoutId)) {
    return { state: "no_scout", queued: 0, processed: 0 };
  }
  if (legs.some((leg) => !["completed", "cancelled"].includes(leg.status))) {
    return { state: "not_complete", queued: 0, processed: 0 };
  }

  const [profile] = await db.select().from(scoutProfiles).where(eq(scoutProfiles.userId, scoutId)).limit(1);
  if (!profile || !scoutConnectReady(profile, getStripeLivemode()) || !profile.stripeAccountId) {
    return { state: "payout_not_ready", queued: 0, processed: 0 };
  }
  if (profile.stripeAccountLivemode !== getStripeLivemode()) {
    throw new Error("Scout payout account belongs to a different Stripe mode.");
  }

  const missionIds = legs.map((leg) => leg.id);
  const paymentRows = (await db.select().from(payments).where(and(
    inArray(payments.missionId, missionIds),
    inArray(payments.status, ["paid", "partially_refunded", "refunded", "disputed"]),
  )).orderBy(asc(payments.createdAt))).filter((payment) => !["tip", "duplicate"].includes(payment.kind) && payment.scoutPayoutCents > 0);
  if (
    !paymentRows.length
    || paymentRows.some((payment) => (
      !payment.stripeChargeId
      || payment.legacyStripeTransferId
      || payment.livemode !== getStripeLivemode()
    ))
  ) {
    return { state: "payment_mismatch", queued: 0, processed: 0 };
  }

  const paymentIds = paymentRows.map((payment) => payment.id);
  const [activeDispute] = await db.select({ id: paymentDisputes.id }).from(paymentDisputes).where(and(
    inArray(paymentDisputes.paymentId, paymentIds),
    notInArray(paymentDisputes.status, ["won", "prevented", "warning_closed", "lost"]),
  )).limit(1);
  if (activeDispute) return { state: "payment_mismatch", queued: 0, processed: 0 };

  const prefix = `transfer:case:${caseId}:payment:`;
  let existingTransfers = await db.select().from(paymentTransfers)
    .where(inArray(paymentTransfers.paymentId, paymentIds));
  const reusableByPayment = new Map<string, typeof paymentTransfers.$inferSelect>();
  for (const transfer of existingTransfers) {
    if (
      transfer.idempotencyKey.startsWith("transfer:case:")
      || transfer.stripeTransferId
      || !["pending", "failed"].includes(transfer.status)
    ) continue;
    if (await reconcilePaymentTransferIdentity(transfer.id) !== "absent") continue;
    const [current] = await db.select().from(paymentTransfers).where(eq(paymentTransfers.id, transfer.id)).limit(1);
    if (current && !current.stripeTransferId && ["pending", "failed"].includes(current.status)) {
      reusableByPayment.set(current.paymentId, current);
    }
  }
  if (reusableByPayment.size) {
    existingTransfers = await db.select().from(paymentTransfers)
      .where(inArray(paymentTransfers.paymentId, paymentIds));
  }
  const existingCaseTransfers = existingTransfers.filter((transfer) => transfer.idempotencyKey.startsWith(prefix));
  const existingCaseCents = existingCaseTransfers.reduce((sum, transfer) => sum + transfer.amountCents, 0);
  if (existingCaseCents > item.missionCase.payoutAmountCents) {
    throw new Error("Existing case transfers exceed the authorized Scout payout.");
  }

  const occupiedPaymentIds = new Set(existingTransfers
    .filter((transfer) => !reusableByPayment.has(transfer.paymentId))
    .map((transfer) => transfer.paymentId));
  let remainingCents = item.missionCase.payoutAmountCents - existingCaseCents;
  const allocations: Array<{ payment: typeof payments.$inferSelect; amountCents: number }> = [];
  for (const payment of paymentRows) {
    if (remainingCents <= 0) break;
    if (occupiedPaymentIds.has(payment.id)) continue;
    const amountCents = Math.min(remainingCents, payment.scoutPayoutCents);
    if (amountCents > 0) allocations.push({ payment, amountCents });
    remainingCents -= amountCents;
  }
  if (remainingCents > 0) return { state: "payment_mismatch", queued: 0, processed: 0 };

  let insertedCount = 0;
  const releaseAttemptedAt = new Date();
  const nextAttemptAt = scoutTransferReleaseIsOpen(releaseAttemptedAt)
    ? releaseAttemptedAt
    : nextScoutTransferReleaseAt(releaseAttemptedAt);
  for (const { payment, amountCents } of allocations) {
    const values = {
      paymentId: payment.id,
      missionId: payment.missionId,
      bundleId: item.bundle?.id ?? null,
      scoutId,
      stripeAccountId: profile.stripeAccountId!,
      kind: "manual" as const,
      amountCents,
      currency: payment.currency,
      sourceChargeId: payment.stripeChargeId!,
      stripeTransferGroup: payment.stripeTransferGroup,
      idempotencyKey: `${prefix}${payment.id}:v1`,
      status: "pending" as const,
      nextAttemptAt,
    };
    const reusable = reusableByPayment.get(payment.id);
    if (reusable) {
      const [updated] = await db.update(paymentTransfers).set({
        ...values,
        stripeTransferId: null,
        reversedAmountCents: 0,
        attemptCount: 0,
        failureCode: null,
        failureMessage: null,
        transferredAt: null,
        reversedAt: null,
        updatedAt: new Date(),
      }).where(and(
        eq(paymentTransfers.id, reusable.id),
        inArray(paymentTransfers.status, ["pending", "failed"]),
        isNull(paymentTransfers.stripeTransferId),
      )).returning({ id: paymentTransfers.id });
      if (updated) insertedCount += 1;
      continue;
    }
    const [inserted] = await db.insert(paymentTransfers).values(values)
      .onConflictDoNothing({ target: paymentTransfers.paymentId })
      .returning({ id: paymentTransfers.id });
    if (inserted) insertedCount += 1;
  }

  const caseTransfers = await db.select().from(paymentTransfers)
    .where(inArray(paymentTransfers.paymentId, paymentIds));
  const exactTransfers = caseTransfers.filter((transfer) => transfer.idempotencyKey.startsWith(prefix));
  if (exactTransfers.reduce((sum, transfer) => sum + transfer.amountCents, 0) !== item.missionCase.payoutAmountCents) {
    return { state: "payment_mismatch", queued: insertedCount, processed: 0 };
  }
  const paymentById = new Map(paymentRows.map((payment) => [payment.id, payment]));
  for (const transfer of exactTransfers) {
    const payment = paymentById.get(transfer.paymentId);
    if (
      !payment
      || transfer.missionId !== payment.missionId
      || transfer.bundleId !== (item.bundle?.id ?? null)
      || transfer.scoutId !== scoutId
      || transfer.stripeAccountId !== profile.stripeAccountId
      || transfer.kind !== "manual"
      || transfer.amountCents <= 0
      || transfer.amountCents > payment.scoutPayoutCents
      || transfer.currency !== payment.currency
      || transfer.sourceChargeId !== payment.stripeChargeId
      || transfer.stripeTransferGroup !== payment.stripeTransferGroup
      || transfer.idempotencyKey !== `${prefix}${payment.id}:v1`
    ) {
      throw new Error(`Existing case transfer ${transfer.id} does not match its funding payment.`);
    }
  }

  let processed = 0;
  for (const transfer of exactTransfers) {
    if (await processPaymentTransfer(transfer.id)) processed += 1;
  }
  return { state: "queued", queued: insertedCount, processed };
}

export async function processPendingPaymentTransfers(limit = 25) {
  const db = getDb();
  const now = new Date();
  const stale = new Date(now.getTime() - 15 * 60 * 1000);
  const rows = await db.select({ id: paymentTransfers.id }).from(paymentTransfers).where(or(
    and(inArray(paymentTransfers.status, ["pending", "failed"]), lte(paymentTransfers.nextAttemptAt, now)),
    and(eq(paymentTransfers.status, "processing"), lt(paymentTransfers.updatedAt, stale)),
  )).orderBy(asc(paymentTransfers.nextAttemptAt)).limit(Math.max(1, Math.min(100, limit)));
  let processed = 0;
  for (const row of rows) if (await processPaymentTransfer(row.id)) processed += 1;
  return { found: rows.length, processed };
}

export async function reconcilePaymentTransferIdentity(transferId: string): Promise<"linked" | "absent"> {
  const db = getDb();
  const [ledger] = await db.select().from(paymentTransfers).where(eq(paymentTransfers.id, transferId)).limit(1);
  if (!ledger) throw new Error("Transfer ledger entry not found for Stripe reconciliation.");
  if (ledger.stripeTransferId) {
    const existing = await getStripe().transfers.retrieve(ledger.stripeTransferId);
    validateStripeTransfer(existing, ledger);
    const reversedAmountCents = Math.max(0, Math.min(existing.amount, existing.amount_reversed));
    await db.update(paymentTransfers).set({
      status: reversedAmountCents >= existing.amount ? "reversed" : reversedAmountCents > 0 ? "partially_reversed" : "succeeded",
      reversedAmountCents,
      transferredAt: ledger.transferredAt ?? new Date(existing.created * 1000),
      reversedAt: reversedAmountCents > 0 ? ledger.reversedAt ?? new Date() : null,
      failureCode: null,
      failureMessage: null,
      updatedAt: new Date(),
    }).where(and(
      eq(paymentTransfers.id, ledger.id),
      eq(paymentTransfers.stripeTransferId, existing.id),
    ));
    return "linked";
  }

  let matched = null;
  for await (const candidate of getStripe().transfers.list({ transfer_group: ledger.stripeTransferGroup, limit: 100 })) {
    if (
      candidate.metadata.sendascout_transfer_id === ledger.id
      || candidate.metadata.sendascout_payment_id === ledger.paymentId
    ) {
      matched = candidate;
      break;
    }
  }
  if (!matched) return "absent";
  validateStripeTransfer(matched, ledger);
  const reversedAmountCents = Math.max(0, Math.min(matched.amount, matched.amount_reversed));
  await db.update(paymentTransfers).set({
    stripeTransferId: matched.id,
    status: reversedAmountCents >= matched.amount ? "reversed" : reversedAmountCents > 0 ? "partially_reversed" : "succeeded",
    reversedAmountCents,
    transferredAt: new Date(matched.created * 1000),
    reversedAt: reversedAmountCents > 0 ? new Date() : null,
    failureCode: null,
    failureMessage: null,
    updatedAt: new Date(),
  }).where(and(eq(paymentTransfers.id, ledger.id), isNull(paymentTransfers.stripeTransferId)));
  return "linked";
}

export async function reconcileSettledPaymentTransfers(limit = 25) {
  const boundedLimit = Math.max(1, Math.min(100, Number.isSafeInteger(limit) ? limit : 25));
  const rows = await getDb().select({ id: paymentTransfers.id }).from(paymentTransfers).where(and(
    inArray(paymentTransfers.status, ["succeeded", "partially_reversed"]),
    sql`${paymentTransfers.stripeTransferId} IS NOT NULL`,
  )).orderBy(asc(paymentTransfers.updatedAt)).limit(boundedLimit);
  let reconciled = 0;
  let errors = 0;
  for (const row of rows) {
    try {
      if (await reconcilePaymentTransferIdentity(row.id) === "linked") reconciled += 1;
    } catch (error) {
      errors += 1;
      console.error("Settled transfer reconciliation failed", {
        transferId: row.id,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
  return { found: rows.length, reconciled, errors };
}

async function holdClaimedPaymentTransfer(
  claimed: typeof paymentTransfers.$inferSelect,
  input: { code: string; message: string; nextAttemptAt: Date },
) {
  await getDb().update(paymentTransfers).set({
    status: "pending",
    failureCode: input.code,
    failureMessage: input.message,
    nextAttemptAt: input.nextAttemptAt,
    updatedAt: new Date(),
  }).where(and(
    eq(paymentTransfers.id, claimed.id),
    eq(paymentTransfers.status, "processing"),
    eq(paymentTransfers.attemptCount, claimed.attemptCount),
    isNull(paymentTransfers.stripeTransferId),
  ));
}

async function holdClaimedPaymentTransferForSchedule(
  claimed: typeof paymentTransfers.$inferSelect,
  livemode: boolean,
  heldAt: Date,
) {
  await getDb().execute(sql`
    WITH held_transfer AS (
      UPDATE payment_transfers AS transfer
      SET status = 'pending',
          failure_code = 'payout_schedule_hold',
          failure_message = 'Stripe did not confirm an enabled weekly Friday payout schedule immediately before transfer release.',
          next_attempt_at = ${new Date(heldAt.getTime() + 15 * 60 * 1000)},
          updated_at = ${heldAt}
      WHERE transfer.id = ${claimed.id}
        AND transfer.status = 'processing'
        AND transfer.attempt_count = ${claimed.attemptCount}
        AND transfer.stripe_transfer_id IS NULL
      RETURNING transfer.scout_id, transfer.stripe_account_id
    )
    UPDATE scout_profiles AS profile
    SET stripe_payout_schedule_configured_at = NULL,
        updated_at = ${heldAt}
    FROM held_transfer
    WHERE profile.user_id = held_transfer.scout_id
      AND profile.stripe_account_id = held_transfer.stripe_account_id
      AND profile.stripe_account_livemode = ${livemode}
  `);
}

export async function processPaymentTransfer(transferId: string) {
  const db = getDb();
  const livemode = getStripeLivemode();
  const now = new Date();
  const stale = new Date(now.getTime() - 15 * 60 * 1000);
  const claimQuery = db.update(paymentTransfers).set({
    status: "processing",
    attemptCount: sql`${paymentTransfers.attemptCount} + 1`,
    failureCode: null,
    failureMessage: null,
    updatedAt: now,
  }).where(and(
    eq(paymentTransfers.id, transferId),
    or(
      and(
        inArray(paymentTransfers.status, ["pending", "failed"]),
        lte(paymentTransfers.nextAttemptAt, now),
        sql`EXISTS (
      SELECT 1
      FROM payments AS funding_payment
      INNER JOIN missions AS settlement_mission
        ON settlement_mission.id = ${paymentTransfers.missionId}
      LEFT JOIN mission_bundles AS settlement_bundle
        ON settlement_bundle.id = ${paymentTransfers.bundleId}
      INNER JOIN scout_profiles AS destination_profile
        ON destination_profile.user_id = ${paymentTransfers.scoutId}
      WHERE funding_payment.id = ${paymentTransfers.paymentId}
        AND funding_payment.legacy_stripe_transfer_id IS NULL
        AND funding_payment.stripe_charge_id = ${paymentTransfers.sourceChargeId}
        AND funding_payment.stripe_transfer_group = ${paymentTransfers.stripeTransferGroup}
        AND funding_payment.currency = ${paymentTransfers.currency}
        AND funding_payment.livemode = ${livemode}
        AND funding_payment.failure_code IS DISTINCT FROM ${LATE_PAYMENT_REFUND_CODE}
        AND settlement_mission.scout_id = ${paymentTransfers.scoutId}
        AND destination_profile.stripe_account_id = ${paymentTransfers.stripeAccountId}
        AND destination_profile.stripe_account_livemode = ${livemode}
        AND destination_profile.stripe_connect_status = 'ready'
        AND destination_profile.stripe_transfers_active = TRUE
        AND destination_profile.payouts_enabled = TRUE
        AND destination_profile.stripe_payout_schedule_configured_at IS NOT NULL
        AND (
          (
            ${paymentTransfers.idempotencyKey} NOT LIKE 'transfer:case:%'
            AND funding_payment.status = 'paid'
            AND funding_payment.refunded_amount_cents = 0
            AND funding_payment.scout_payout_cents = ${paymentTransfers.amountCents}
            AND (
              (${paymentTransfers.bundleId} IS NULL AND settlement_mission.status = 'completed')
              OR (
                ${paymentTransfers.bundleId} IS NOT NULL
                AND settlement_bundle.status = 'completed'
                AND NOT EXISTS (
                  SELECT 1 FROM missions AS unsettled_leg
                  WHERE unsettled_leg.bundle_id = ${paymentTransfers.bundleId}
                    AND (
                      unsettled_leg.status <> 'completed'
                      OR unsettled_leg.scout_id IS DISTINCT FROM ${paymentTransfers.scoutId}
                    )
                )
              )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM mission_cases AS financial_case
              INNER JOIN missions AS case_mission ON case_mission.id = financial_case.mission_id
              WHERE financial_case.status = 'resolved'
                AND (
                  financial_case.resolution = 'cancel'
                  OR (
                    financial_case.resolution = 'complete'
                    AND (financial_case.refund_amount_cents > 0 OR financial_case.payout_amount_cents > 0)
                  )
                )
                AND (
                  (${paymentTransfers.bundleId} IS NULL AND case_mission.id = settlement_mission.id)
                  OR (${paymentTransfers.bundleId} IS NOT NULL AND case_mission.bundle_id = ${paymentTransfers.bundleId})
                )
            )
            AND NOT EXISTS (
              SELECT 1 FROM payment_refunds AS active_refund
              WHERE active_refund.payment_id = funding_payment.id
                AND active_refund.status IN ('pending', 'requires_action', 'succeeded')
            )
            AND NOT EXISTS (
              SELECT 1 FROM payment_disputes AS blocking_dispute
              WHERE blocking_dispute.payment_id = funding_payment.id
                AND blocking_dispute.status NOT IN ('won', 'prevented', 'warning_closed')
            )
          )
          OR (
            ${paymentTransfers.kind} = 'manual'
            AND ${paymentTransfers.idempotencyKey} LIKE 'transfer:case:%'
            AND funding_payment.status IN ('paid', 'partially_refunded', 'refunded', 'disputed')
            AND ${paymentTransfers.amountCents} > 0
            AND ${paymentTransfers.amountCents} <= funding_payment.scout_payout_cents
            AND (
              (
                ${paymentTransfers.bundleId} IS NULL
                AND settlement_mission.status IN ('completed', 'cancelled')
              )
              OR (
                ${paymentTransfers.bundleId} IS NOT NULL
                AND settlement_bundle.status IN ('completed', 'cancelled')
                AND NOT EXISTS (
                  SELECT 1 FROM missions AS unsettled_case_leg
                  WHERE unsettled_case_leg.bundle_id = ${paymentTransfers.bundleId}
                    AND (
                      unsettled_case_leg.status NOT IN ('completed', 'cancelled')
                      OR unsettled_case_leg.scout_id IS DISTINCT FROM ${paymentTransfers.scoutId}
                    )
                )
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM payment_refunds AS unsettled_refund
              WHERE unsettled_refund.payment_id = funding_payment.id
                AND unsettled_refund.status IN ('pending', 'requires_action')
            )
            AND NOT EXISTS (
              SELECT 1 FROM payment_disputes AS active_dispute
              WHERE active_dispute.payment_id = funding_payment.id
                AND active_dispute.status NOT IN ('won', 'prevented', 'warning_closed', 'lost')
            )
            AND EXISTS (
              SELECT 1
              FROM mission_cases AS authorized_case
              INNER JOIN missions AS case_mission ON case_mission.id = authorized_case.mission_id
              WHERE authorized_case.status = 'resolved'
                AND authorized_case.resolution IN ('cancel', 'complete')
                AND authorized_case.payout_amount_cents > 0
                AND ${paymentTransfers.idempotencyKey} =
                  ('transfer:case:' || authorized_case.id::text || ':payment:' || funding_payment.id::text || ':v1')
                AND (
                  (${paymentTransfers.bundleId} IS NULL AND case_mission.id = settlement_mission.id)
                  OR (${paymentTransfers.bundleId} IS NOT NULL AND case_mission.bundle_id = ${paymentTransfers.bundleId})
                )
                AND authorized_case.payout_amount_cents = (
                  SELECT COALESCE(SUM(case_transfer.amount_cents), 0)::integer
                  FROM payment_transfers AS case_transfer
                  WHERE case_transfer.idempotency_key LIKE
                    ('transfer:case:' || authorized_case.id::text || ':payment:%')
                )
            )
          )
        )
        )`,
      ),
      and(eq(paymentTransfers.status, "processing"), lt(paymentTransfers.updatedAt, stale)),
    ),
  )).returning({
    id: paymentTransfers.id,
    attemptCount: paymentTransfers.attemptCount,
  });
  const claimStatement = claimQuery.toSQL();
  let claimIdentity: { id: string; attempt_count: number } | null = null;
  let previousStatus: string | null = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const [lockedRows, claimedRows] = await db.$client.transaction(
        (transaction) => [
          transaction.query(`
            SELECT transfer.status AS previous_status
            FROM payment_transfers AS transfer
            INNER JOIN payments AS payment ON payment.id = transfer.payment_id
            WHERE transfer.id = $1::uuid
            FOR UPDATE OF payment
          `, [transferId]),
          transaction.query(claimStatement.sql, claimStatement.params),
        ],
        { isolationLevel: "Serializable" },
      );
      previousStatus = String((lockedRows as Array<{ previous_status: string }>)[0]?.previous_status ?? "") || null;
      claimIdentity = (claimedRows as Array<{ id: string; attempt_count: number }>)[0] ?? null;
      break;
    } catch (error) {
      if (!isSerializationFailure(error) || attempt === 4) throw error;
    }
  }
  if (!claimIdentity) return false;
  const [claimed] = await db.select().from(paymentTransfers).where(and(
    eq(paymentTransfers.id, claimIdentity.id),
    eq(paymentTransfers.status, "processing"),
    eq(paymentTransfers.attemptCount, Number(claimIdentity.attempt_count)),
  )).limit(1);
  if (!claimed) return false;

  let saved = false;
  let priorTransferOutcomeMayExist = previousStatus === "processing";
  let transferRequestStarted = false;
  let transferResponseReceived = false;
  try {
    const stripe = getStripe();
    const reconciliation = await reconcilePaymentTransferIdentity(claimed.id);
    if (reconciliation === "absent") priorTransferOutcomeMayExist = false;
    const [reconciled] = await db.select().from(paymentTransfers).where(eq(paymentTransfers.id, claimed.id)).limit(1);
    let transfer: Stripe.Transfer;
    let transferAlreadyLinked = false;
    if (reconciled?.stripeTransferId) {
      transfer = await stripe.transfers.retrieve(reconciled.stripeTransferId);
      transferAlreadyLinked = true;
    } else {
      const releaseCheckedAt = new Date();
      if (!scoutTransferReleaseIsOpen(releaseCheckedAt)) {
        await holdClaimedPaymentTransfer(claimed, {
          code: "friday_release_hold",
          message: "Scout earnings transfers release only on Friday UTC.",
          nextAttemptAt: nextScoutTransferReleaseAt(releaseCheckedAt),
        });
        return false;
      }
      if (!await claimedTransferStillEligible(claimed)) {
        await db.update(paymentTransfers).set({
          status: "pending",
          failureCode: "eligibility_hold",
          failureMessage: "Payout eligibility changed after this transfer was claimed. It will be rechecked before any Stripe transfer.",
          nextAttemptAt: new Date(Date.now() + 15 * 60 * 1000),
          updatedAt: new Date(),
        }).where(and(
          eq(paymentTransfers.id, claimed.id),
          eq(paymentTransfers.status, "processing"),
          eq(paymentTransfers.attemptCount, claimed.attemptCount),
          isNull(paymentTransfers.stripeTransferId),
        ));
        return false;
      }
      const balanceSettings = await stripe.balanceSettings.retrieve({}, { stripeContext: claimed.stripeAccountId });
      if (!stripeBalanceSettingsUseRequiredFridaySchedule(balanceSettings)) {
        const heldAt = new Date();
        await holdClaimedPaymentTransferForSchedule(claimed, livemode, heldAt);
        return false;
      }
      const createCheckedAt = new Date();
      if (!scoutTransferReleaseIsOpen(createCheckedAt)) {
        await holdClaimedPaymentTransfer(claimed, {
          code: "friday_release_hold",
          message: "Scout earnings transfers release only on Friday UTC.",
          nextAttemptAt: nextScoutTransferReleaseAt(createCheckedAt),
        });
        return false;
      }
      transferRequestStarted = true;
      transfer = await stripe.transfers.create({
        amount: claimed.amountCents,
        currency: claimed.currency,
        destination: claimed.stripeAccountId,
        source_transaction: claimed.sourceChargeId,
        transfer_group: claimed.stripeTransferGroup,
        description: `Send a Scout ${claimed.kind} earnings`,
        metadata: {
          sendascout_transfer_id: claimed.id,
          sendascout_payment_id: claimed.paymentId,
          sendascout_mission_id: claimed.missionId,
          sendascout_scout_id: claimed.scoutId,
        },
      }, { idempotencyKey: claimed.idempotencyKey });
      transferResponseReceived = true;
    }
    validateStripeTransfer(transfer, claimed);
    if (transferAlreadyLinked) {
      saved = true;
    } else {
      const completedAt = new Date();
      const [savedRow] = await db.update(paymentTransfers).set({
        stripeTransferId: transfer.id,
        status: "succeeded",
        transferredAt: completedAt,
        nextAttemptAt: completedAt,
        failureCode: null,
        failureMessage: null,
        updatedAt: completedAt,
      }).where(and(
        eq(paymentTransfers.id, claimed.id),
        eq(paymentTransfers.status, "processing"),
        eq(paymentTransfers.attemptCount, claimed.attemptCount),
      )).returning({ id: paymentTransfers.id });
      saved = Boolean(savedRow);
    }
  } catch (error) {
    const details = stripeErrorDetails(error);
    const attempt = claimed.attemptCount;
    const delayMinutes = Math.min(360, 2 ** Math.min(8, attempt));
    const preserveCommitment = priorTransferOutcomeMayExist
      || transferResponseReceived
      || (transferRequestStarted && stripeTransferOutcomeMayBeUnknown(error));
    await db.update(paymentTransfers).set({
      status: preserveCommitment ? "processing" : "failed",
      failureCode: details.code,
      failureMessage: `${preserveCommitment ? "Transfer outcome requires Stripe reconciliation. " : ""}${details.message}`.slice(0, 1000),
      nextAttemptAt: new Date(Date.now() + delayMinutes * 60 * 1000),
      updatedAt: new Date(),
    }).where(and(
      eq(paymentTransfers.id, claimed.id),
      eq(paymentTransfers.status, "processing"),
      eq(paymentTransfers.attemptCount, claimed.attemptCount),
    ));
    console.error("Scout earnings transfer failed", {
      transferId: claimed.id,
      code: details.code,
      attempt,
      outcomeUnknown: preserveCommitment,
    });
    return false;
  }

  if (saved) {
    try {
      await notifyUser({
        recipientUserId: claimed.scoutId,
        missionId: claimed.missionId,
        kind: "earnings_released",
        title: claimed.kind === "tip" ? "Scout tip released" : "Mission earnings released",
        body: `$${(claimed.amountCents / 100).toFixed(2)} reached your Stripe balance. Stripe pays available funds on your configured payout schedule.`,
        actionLabel: "View earnings",
        actionUrl: "https://sendascout.com/dashboard/scout/earnings",
      });
    } catch (error) {
      console.error("Scout transfer notification failed", { transferId: claimed.id, error });
    }
  }
  return saved;
}

async function claimedTransferStillEligible(transfer: typeof paymentTransfers.$inferSelect) {
  const db = getDb();
  const livemode = getStripeLivemode();
  const [scope] = await db.select({
    payment: payments,
    mission: missions,
    bundle: missionBundles,
    profile: scoutProfiles,
  }).from(payments)
    .innerJoin(missions, eq(missions.id, transfer.missionId))
    .leftJoin(missionBundles, sql`${missionBundles.id} = ${transfer.bundleId}::uuid`)
    .innerJoin(scoutProfiles, eq(scoutProfiles.userId, transfer.scoutId))
    .where(eq(payments.id, transfer.paymentId))
    .limit(1);
  if (!scope) return false;
  if (
    scope.payment.legacyStripeTransferId
    || scope.payment.failureCode === LATE_PAYMENT_REFUND_CODE
    || scope.payment.stripeChargeId !== transfer.sourceChargeId
    || scope.payment.stripeTransferGroup !== transfer.stripeTransferGroup
    || scope.payment.currency !== transfer.currency
    || scope.payment.livemode !== livemode
    || scope.mission.scoutId !== transfer.scoutId
    || scope.mission.bundleId !== transfer.bundleId
    || scope.profile.stripeAccountId !== transfer.stripeAccountId
    || scope.profile.stripeAccountLivemode !== livemode
    || !scoutConnectReady(scope.profile, livemode)
  ) return false;

  const legs = transfer.bundleId
    ? await db.select().from(missions).where(eq(missions.bundleId, transfer.bundleId))
    : [scope.mission];
  if (!legs.length || legs.some((leg) => leg.scoutId !== transfer.scoutId)) return false;

  const caseMatch = /^transfer:case:([0-9a-f-]{36}):payment:([0-9a-f-]{36}):v1$/i.exec(transfer.idempotencyKey);
  const isCaseTransfer = transfer.kind === "manual" && caseMatch?.[2] === transfer.paymentId;
  const [refundRows, disputeRows] = await Promise.all([
    db.select({ status: paymentRefunds.status }).from(paymentRefunds)
      .where(eq(paymentRefunds.paymentId, transfer.paymentId)),
    db.select({ status: paymentDisputes.status }).from(paymentDisputes)
      .where(eq(paymentDisputes.paymentId, transfer.paymentId)),
  ]);

  if (isCaseTransfer && caseMatch) {
    if (
      scope.payment.kind === "tip"
      || !["paid", "partially_refunded", "refunded", "disputed"].includes(scope.payment.status)
      || transfer.amountCents <= 0
      || transfer.amountCents > scope.payment.scoutPayoutCents
      || refundRows.some((refund) => ["pending", "requires_action"].includes(refund.status))
      || disputeRows.some((dispute) => !["won", "prevented", "warning_closed", "lost"].includes(dispute.status))
      || legs.some((leg) => !["completed", "cancelled"].includes(leg.status))
      || (scope.bundle && !["completed", "cancelled"].includes(scope.bundle.status))
    ) return false;
    const [authorizedCase] = await db.select().from(missionCases)
      .where(eq(missionCases.id, caseMatch[1]))
      .limit(1);
    if (
      !authorizedCase
      || authorizedCase.status !== "resolved"
      || !["cancel", "complete"].includes(authorizedCase.resolution ?? "")
      || authorizedCase.payoutAmountCents <= 0
      || !legs.some((leg) => leg.id === authorizedCase.missionId)
    ) return false;
    const [caseTotal] = await db.select({
      amountCents: sql<number>`COALESCE(SUM(${paymentTransfers.amountCents}), 0)::integer`,
    }).from(paymentTransfers).where(sql`
      ${paymentTransfers.idempotencyKey} LIKE ${`transfer:case:${authorizedCase.id}:payment:%`}
    `);
    return Number(caseTotal?.amountCents ?? 0) === authorizedCase.payoutAmountCents;
  }

  if (
    transfer.idempotencyKey.startsWith("transfer:case:")
    || scope.payment.status !== "paid"
    || scope.payment.refundedAmountCents !== 0
    || scope.payment.scoutPayoutCents !== transfer.amountCents
    || refundRows.some((refund) => ["pending", "requires_action", "succeeded"].includes(refund.status))
    || disputeRows.some((dispute) => !["won", "prevented", "warning_closed"].includes(dispute.status))
    || legs.some((leg) => leg.status !== "completed")
    || scope.mission.status !== "completed"
    || (scope.bundle && scope.bundle.status !== "completed")
  ) return false;
  const [financialCase] = await db.select({ id: missionCases.id }).from(missionCases)
    .innerJoin(missions, eq(missions.id, missionCases.missionId))
    .where(and(
      eq(missionCases.status, "resolved"),
      transfer.bundleId
        ? eq(missions.bundleId, transfer.bundleId)
        : eq(missions.id, transfer.missionId),
      sql`(
        ${missionCases.resolution} = 'cancel'
        OR (
          ${missionCases.resolution} = 'complete'
          AND (${missionCases.refundAmountCents} > 0 OR ${missionCases.payoutAmountCents} > 0)
        )
      )`,
    ))
    .limit(1);
  return !financialCase;
}

function isSerializationFailure(error: unknown) {
  const candidate = error as { code?: unknown; message?: unknown; sourceError?: { code?: unknown } };
  const code = String(candidate.code ?? candidate.sourceError?.code ?? "");
  return code === "40001" || String(candidate.message ?? "").toLowerCase().includes("could not serialize access");
}

function stripeTransferOutcomeMayBeUnknown(error: unknown) {
  const { type } = stripeErrorDetails(error);
  return ![
    "StripeInvalidRequestError",
    "StripeAuthenticationError",
    "StripePermissionError",
    "StripeRateLimitError",
    "StripeCardError",
  ].includes(type);
}

function transferKind(paymentKind: string): "mission" | "tip" | "adjustment" | "manual" {
  if (paymentKind === "booking") return "mission";
  if (paymentKind === "tip") return "tip";
  if (paymentKind === "manual") return "manual";
  return "adjustment";
}

function validateStripeTransfer(transfer: Stripe.Transfer, ledger: typeof paymentTransfers.$inferSelect) {
  if (
    transfer.amount !== ledger.amountCents
    || transfer.currency !== ledger.currency
    || transfer.livemode !== getStripeLivemode()
    || stripeObjectId(transfer.destination) !== ledger.stripeAccountId
    || stripeObjectId(transfer.source_transaction) !== ledger.sourceChargeId
    || transfer.transfer_group !== ledger.stripeTransferGroup
  ) {
    throw new Error("Stripe transfer response did not match the payout ledger.");
  }
}
